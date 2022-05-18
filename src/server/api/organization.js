import { mapFieldsToModel } from "./lib/utils";
import { getConfig, getFeatures } from "./lib/config";
import { r, Organization, cacheableData } from "../models";
import ownedPhoneNumber from "./lib/owned-phone-number";
import { getTags } from "./tag";
import { accessRequired } from "./errors";
import { getCampaigns } from "./campaign";
import { buildUsersQuery } from "./user";
import {
  getHandlerDisplayName as getActionHandlerDisplayName,
  getHandlerDescription as getActionHandlerDescription
} from "../../extensions/action-handlers";
import {
  getHandlerDisplayName as getMessageHandlerDisplayName,
  getHandlerDescription as getMessageHandlerDescription
} from "../../extensions/message-handlers";
import {
  getHandlerDisplayName as getContactLoaderDisplayName,
  getHandlerDescription as getContactLoaderDescription
} from "../../extensions/contact-loaders";

import {
  fullyConfigured,
  getServiceMetadata
} from "../../extensions/service-vendors";
import { getServiceManagerData } from "../../extensions/service-managers";

export const ownerConfigurable = {
  // ACTION_HANDLERS: 1,
  ALLOW_SEND_ALL_ENABLED: 1,
  DEFAULT_BATCHSIZE: 1,
  DEFAULT_RESPONSEWINDOW: 1,
  MAX_CONTACTS_PER_TEXTER: 1,
  MAX_MESSAGE_LENGTH: 1,
  CONTACT_LOADERS: 1
  // MESSAGE_HANDLERS: 1,
  // There is already an endpoint and widget for this:
  // opt_out_message: 1
};

export const getAllowed = (organization, user) => {
  const configable = getConfig("OWNER_CONFIGURABLE", organization);
  const allowed = {};
  ((configable && configable.split(",")) || []).forEach(c => {
    allowed[c] = 1;
  });
  if (user.is_superadmin) {
    allowed["ALL"] = 1;
  }
  return Object.keys(allowed.ALL ? ownerConfigurable : allowed);
};

export const getSideboxChoices = organization => {
  // should match defaults with src/extensions/texter-sideboxes/components.js
  const sideboxes = getConfig("TEXTER_SIDEBOXES", organization);
  const sideboxChoices =
    sideboxes === undefined
      ? [
          "celebration-gif",
          "default-dynamicassignment",
          "default-releasecontacts",
          "contact-reference",
          "default-editinitial",
          "tag-contact"
        ]
      : (sideboxes && sideboxes.split(",")) || [];
  return sideboxChoices;
};

export const resolvers = {
  Organization: {
    ...mapFieldsToModel(["id", "name"], Organization),
    campaigns: async (
      organization,
      { cursor, campaignsFilter, sortBy },
      { user }
    ) => {
      await accessRequired(user, organization.id, "SUPERVOLUNTEER", true);
      return getCampaigns(organization.id, cursor, campaignsFilter, sortBy);
    },
    campaignsCount: async (organization, _, { user }) => {
      await accessRequired(user, organization.id, "OWNER", true);
      return r.getCount(
        r
          .knex("campaign")
          .where({ organization_id: organization.id, is_archived: false })
      );
    },
    numTextsInLastDay: async (organization, _, { user }) => {
      await accessRequired(user, organization.id, "OWNER", true);
      return getNumTextsInLastDay(organization.id);
    },
    uuid: async (organization, _, { user }) => {
      await accessRequired(user, organization.id, "SUPERVOLUNTEER");
      return organization.uuid;
    },
    optOuts: async (organization, _, { user }) => {
      await accessRequired(user, organization.id, "ADMIN");
      return r
        .table("opt_out")
        .getAll(organization.id, { index: "organization_id" });
    },
    people: async (organization, { role, campaignId, sortBy }, { user }) => {
      await accessRequired(user, organization.id, "SUPERVOLUNTEER");
      return buildUsersQuery(organization.id, role, { campaignId }, sortBy);
    },
    tags: async (organization, { group }, { user }) => {
      let groupFilter = group;
      try {
        await accessRequired(user, organization.id, "SUPERVOLUNTEER");
      } catch (err) {
        await accessRequired(user, organization.id, "TEXTER");
        groupFilter = "texter-tags";
      }
      return getTags(organization, groupFilter);
    },
    batchPolicies: organization => {
      const batchPolicies = getConfig(
        "DYNAMICASSIGNMENT_BATCHES",
        organization
      );
      return batchPolicies
        ? batchPolicies.split(",")
        : ["finished-replies", "vetted-texters"];
    },
    profileFields: organization =>
      // @todo: standardize on escaped or not once there's an interface.
      typeof getFeatures(organization).profile_fields === "string"
        ? JSON.parse(getFeatures(organization).profile_fields)
        : getFeatures(organization).profile_fields || [],
    availableActions: async (organization, _, { user, loaders }) => {
      await accessRequired(user, organization.id, "SUPERVOLUNTEER");
      const availableHandlers = await getAvailableActionHandlers(
        organization,
        user
      );

      const promises = availableHandlers.map(handler => {
        return getActionChoiceData(handler, organization, user, loaders).then(
          clientChoiceData => {
            return {
              name: handler.name,
              displayName: handler.displayName(),
              instructions: handler.instructions(),
              clientChoiceData
            };
          }
        );
      });

      return Promise.all(promises);
    },
    allowSendAll: organization =>
      Boolean(
        // the first ALLOW_SEND_ALL is NOT per-org
        // to make sure the system administrator has enabled it
        getConfig("ALLOW_SEND_ALL", null, { truthy: 1 }) &&
          getConfig("ALLOW_SEND_ALL", organization, { truthy: 1 }) &&
          getFeatures(organization).ALLOW_SEND_ALL_ENABLED
      ),
    theme: async organization => {
      const themeOptions = {
        palette: {
          type: "light",
          primary: {
            main: "#209556"
          },
          secondary: {
            main: "#555555"
          },
          warning: {
            main: "#fabe28"
          },
          info: {
            main: "#3f80b2"
          }
        }
      };
      // return themeOptions;
      return getFeatures(organization).theme || themeOptions;
    },
    extensionSettings: async (organization, _, { user, loaders }) => {
      try {
        await accessRequired(user, organization.id, "OWNER", true);
      } catch (err) {
        return null;
      }
      const configurableSettings = getAllowed(organization, user);

      const configurableMessageHandlers =
        configurableSettings.includes("MESSAGE_HANDLERS") &&
        getConfig("MESSAGE_HANDLERS");
      const allowedMessageHandlers =
        configurableMessageHandlers &&
        configurableMessageHandlers !== undefined &&
        configurableMessageHandlers !== ""
          ? configurableMessageHandlers.split(",")
          : [];

      const configurableActionHandlers =
        configurableSettings.includes("ACTION_HANDLERS") &&
        getConfig("ACTION_HANDLERS");
      const allowedActionHandlers =
        configurableActionHandlers &&
        configurableActionHandlers !== undefined &&
        configurableActionHandlers !== ""
          ? configurableActionHandlers.split(",")
          : [];

      const configurableContactLoaders =
        configurableSettings.includes("CONTACT_LOADERS") &&
        getConfig("CONTACT_LOADERS");

      console.log("Configurable Contact Loaders", configurableContactLoaders);
      console.log("Configurable Settings", configurableSettings);
      console.log(
        "Get Configurable Contact Loaders",
        getConfig("CONTACT_LOADERS")
      );

      const allowedContactLoaders =
        configurableContactLoaders !== undefined &&
        configurableContactLoaders != ""
          ? configurableContactLoaders.split(",")
          : [];

      // reads from DB, where these are grouped under features.EXTENSION_SETTINGS
      const extensionSettings =
        getConfig("EXTENSION_SETTINGS", organization) || [];
      let savedMessageHandlers =
        (extensionSettings.MESSAGE_HANDLERS &&
          extensionSettings.MESSAGE_HANDLERS.split(",")) ||
        [];
      let savedActionHandlers =
        (extensionSettings.ACTION_HANDLERS &&
          extensionSettings.ACTION_HANDLERS.split(",")) ||
        [];
      let savedContactLoaders =
        (extensionSettings.CONTACT_LOADERS &&
          extensionSettings.CONTACT_LOADERS.split(",")) ||
        [];

      // build display name and description dictionary for each handler
      const displayInformationDictionary = {};
      allowedContactLoaders.map(handler => {
        const displayName = getContactLoaderDisplayName(handler);
        const description = getContactLoaderDescription(handler);
        displayInformationDictionary[handler] = {
          displayName: displayName,
          description: description
        };
      });
      allowedActionHandlers.map(handler => {
        const displayName = getActionHandlerDisplayName(handler);
        const description = getActionHandlerDescription(handler);
        displayInformationDictionary[handler] = {
          displayName: displayName,
          description: description
        };
      });
      allowedMessageHandlers.map(handler => {
        const displayName = getMessageHandlerDisplayName(handler);
        const description = getMessageHandlerDescription(handler);
        displayInformationDictionary[handler] = {
          displayName: displayName,
          description: description
        };
      });

      const handlerDisplayInformation = JSON.stringify(
        displayInformationDictionary
      );

      console.log({
        savedMessageHandlers,
        savedActionHandlers,
        savedContactLoaders,
        allowedMessageHandlers,
        allowedActionHandlers,
        allowedContactLoaders,
        handlerDisplayInformation
      });

      return {
        savedMessageHandlers,
        savedActionHandlers,
        savedContactLoaders,
        allowedMessageHandlers,
        allowedActionHandlers,
        allowedContactLoaders,
        handlerDisplayInformation
      };
    },
    defaultSettings: async (organization, _, { user, loaders }) => {
      try {
        await accessRequired(user, organization.id, "OWNER", true);
      } catch (err) {
        return null;
      }

      // reads from DB, where these are grouped under features.DEFAULT_SETTINGS
      const features = getConfig("DEFAULT_SETTINGS", organization) || null;
      const visibleFeatures = {};
      const unsetFeatures = [];
      if (features !== null) {
        getAllowed(organization, user).forEach(f => {
          if (features.hasOwnProperty(f)) {
            visibleFeatures[f] = features[f];
          } else {
            unsetFeatures.push(f);
          }
        });
      }

      return {
        unsetFeatures,
        featuresJSON: JSON.stringify(visibleFeatures)
      };
    },
    textingHoursEnforced: organization => organization.texting_hours_enforced,
    optOutMessage: organization =>
      (organization.features &&
      organization.features.indexOf("opt_out_message") !== -1
        ? JSON.parse(organization.features).opt_out_message
        : getConfig("OPT_OUT_MESSAGE")) ||
      "I'm opting you out of texts immediately. Have a great day.",
    textingHoursStart: organization => organization.texting_hours_start,
    textingHoursEnd: organization => organization.texting_hours_end,
    texterUIConfig: async (organization, _, { user }) => {
      try {
        await accessRequired(user, organization.id, "OWNER");
      } catch (caught) {
        return null;
      }

      const options = getConfig("TEXTER_UI_SETTINGS", organization) || null;
      // note this is global, since we need the set that's globally enabled/allowed to choose from
      const sideboxChoices = getSideboxChoices();
      return {
        options,
        sideboxChoices
      };
    },
    cacheable: (org, _, { user }) =>
      // quanery logic.  levels are 0, 1, 2
      r.redis ? (getConfig("REDIS_CONTACT_CACHE", org) ? 2 : 1) : 0,
    serviceVendor: async (organization, _, { user }) => {
      try {
        await accessRequired(user, organization.id, "OWNER");
        const serviceName = cacheableData.organization.getMessageService(
          organization
        );
        const serviceMetadata = getServiceMetadata(serviceName);
        return {
          id: `org${organization.id}-${serviceName}`,
          ...serviceMetadata,
          config: cacheableData.organization.getMessageServiceConfig(
            organization,
            { restrictToOrgFeatures: true, obscureSensitiveInformation: true }
          )
        };
      } catch (caught) {
        console.log("organization.messageService error", caught);
        return null;
      }
    },
    serviceManagers: async (organization, _, { user, loaders }) => {
      try {
        await accessRequired(user, organization.id, "OWNER", true);
        const result = await getServiceManagerData(
          "getOrganizationData",
          organization,
          { organization, user, loaders }
        );
        return result.map(r => ({
          id: `${r.name}-org${organization.id}-`,
          organization,
          // defaults
          fullyConfigured: null,
          data: null,
          ...r
        }));
      } catch (err) {
        console.log("orgaization.serviceManagers error", err);
        return [];
      }
    },
    fullyConfigured: async organization => {
      return fullyConfigured(organization);
    },
    emailEnabled: async (organization, _, { user }) => {
      await accessRequired(user, organization.id, "SUPERVOLUNTEER", true);
      return Boolean(getConfig("EMAIL_HOST", organization));
    },
    phoneInventoryEnabled: async (organization, _, { user }) => {
      await accessRequired(user, organization.id, "SUPERVOLUNTEER", true);
      return (
        getConfig("EXPERIMENTAL_PHONE_INVENTORY", organization, {
          truthy: true
        }) ||
        getConfig("PHONE_INVENTORY", organization, {
          truthy: true
        })
      );
    },
    campaignPhoneNumbersEnabled: async (organization, _, { user }) => {
      // TODO: consider removal (moved to extensions/service-managers/per-campaign-messageservices
      await accessRequired(user, organization.id, "SUPERVOLUNTEER");
      const inventoryEnabled =
        getConfig("EXPERIMENTAL_PHONE_INVENTORY", organization, {
          truthy: true
        }) ||
        getConfig("PHONE_INVENTORY", organization, {
          truthy: true
        });
      const configured =
        inventoryEnabled &&
        getConfig("EXPERIMENTAL_CAMPAIGN_PHONE_NUMBERS", organization, {
          truthy: true
        });
      // check that the incompatible strategies are not enabled
      const manualMsgServiceFeatureEnabled = getConfig(
        "EXPERIMENTAL_TWILIO_PER_CAMPAIGN_MESSAGING_SERVICE",
        organization,
        { truthy: true }
      );
      if (configured && manualMsgServiceFeatureEnabled) {
        throw new Error(
          "Incompatible phone number management features enabled"
        );
      }
      return configured;
    },
    pendingPhoneNumberJobs: async (organization, _, { user }) => {
      await accessRequired(user, organization.id, "ADMIN", true);
      const jobs = await r
        .knex("job_request")
        .whereIn("job_type", ["buy_phone_numbers", "delete_phone_numbers"])
        .andWhere("organization_id", organization.id)
        .orderBy("updated_at", "desc");
      return jobs.map(j => {
        const payload = JSON.parse(j.payload);
        return {
          id: j.id,
          assigned: j.assigned,
          status: j.status,
          resultMessage: j.result_message,
          areaCode: payload.areaCode,
          limit: payload.limit || 0
        };
      });
    },
    phoneNumberCounts: async (organization, _, { user }) => {
      try {
        await accessRequired(user, organization.id, "ADMIN");
      } catch (err) {
        // for SUPERVOLUNTEERS
        return [];
      }
      if (
        !getConfig("EXPERIMENTAL_PHONE_INVENTORY", organization, {
          truthy: true
        }) &&
        !getConfig("PHONE_INVENTORY", organization, {
          truthy: true
        })
      ) {
        return [];
      }
      return await ownedPhoneNumber.listOrganizationCounts(organization);
    }
  }
};

export async function getNumTextsInLastDay(organizationId) {
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const textsInLastDay = r.knex
    .from("message")
    .join(
      "campaign_contact",
      "message.campaign_contact_id",
      "campaign_contact.id"
    )
    .join("campaign", "campaign.id", "campaign_contact.campaign_id")
    .where({ "campaign.organization_id": organizationId })
    .where("message.sent_at", ">=", yesterday);
  const numTexts = await r.getCount(textsInLastDay);
  return numTexts;
}
