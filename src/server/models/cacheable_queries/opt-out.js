import { r, OptOut } from '../../models'
import { assignmentCache } from './assignment'

// STRUCTURE
// maybe HASH by organization, so optout-<organization_id> has a <cell> key

const orgCacheKey = (orgId) => `${process.env.CACHE_PREFIX|""}optouts-${orgId}`

const loadMany = async (organizationId) => {
  if (r.redis) {
    const dbResult = await r.knex('opt_out')
      .select('cell')
      .where('organization_id', organizationId)
    const cellOptOuts = dbResult.map((rec) => rec.cell)
    const hashKey = orgCacheKey(organizationId)
    // save 100 at a time
    for (let i100=0, l100=Math.ceil(cellOptOuts.length/100); i100<l100; i100++) {
      await r.redis.saddAsync(hashKey, cellOptOuts.slice(100*i100, 100*i100 + 100))
    }
    await r.redis.expire(hashKey, 86400)
    console.log(`CACHE: Loaded optouts for ${organizationId}`)
  }
}

export const optOutCache = {
  clearQuery: async ({cell, organizationId}) => {
    // remove cache by organization
    // (if no cell is present, then clear whole query of organization)
    if (r.redis) {
      if (cell) {
        await r.redis.sdelAsync(orgCacheKey(organizationId), cell)
      } else {
        await r.redis.delAsync(orgCacheKey(organizationId))
      }
    }
  },
  query: async ({cell, organizationId}) => {
    // return optout result by db or by cache.
    // for a particular organization, if the org Id is NOT cached
    // then cache the WHOLE set of opt-outs for organizationId at once
    // and expire them in a day.
    if (r.redis) {
      const hashKey = orgCacheKey(organizationId)
      const [exists, isMember] = await r.redis.multi()
        .exists(hashKey)
        .sismember(hashKey, cell)
        .execAsync()
      if (exists) {
        return isMember
      } else {
        // note NOT awaiting this -- it should run in background
        // ideally not blocking the rest of the request
        loadMany(organizationId)
      }
    }
    const dbResult = await r.knex('opt_out')
      .select('cell')
      .where({'organization_id': organizationId,
              'cell': cell})
      .limit(1)
    return (dbResult.length > 0)
  },
  save: async ({cell, campaignContactId, organizationId, assignmentId, reason}) => {
    if (r.redis) {
      const hashKey = orgCacheKey(organizationId)
      const exists = await r.redis.existsAsync(hashKey)
      if (exists) {
        await r.redis.saddAsync(hashKey, cell)
      }
      await assignmentCache.optOutContact(assignmentId, campaignContactId)
    }
    // database
    await new OptOut({
      assignment_id: assignmentId,
      organization_id: organizationId,
      reason_code: reason,
      cell
    }).save()

    // update all organization's active campaigns as well
    await r
      .knex('campaign_contact')
      .where(
        'id',
        'in',
        r.knex('campaign_contact')
          .leftJoin('campaign', 'campaign_contact.campaign_id', 'campaign.id')
          .where({
            'campaign_contact.cell': cell,
            'campaign.organization_id': organizationId,
            'campaign.is_archived': false
          })
          .select('campaign_contact.id')
      )
      .update({
        is_opted_out: true
      })
  },
  loadMany: loadMany
}
