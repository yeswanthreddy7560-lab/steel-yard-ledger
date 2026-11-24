"use strict";

const { listActions } = require("../actions");
const { normalize } = require("../helpers");

module.exports = {
  id: "change",
  name: "Change Agent",
  description: "Proposes and applies allowed data changes after admin confirmation",
  keywords: [/change/, /approve user/, /revoke user/, /user #?\d+/, /unban/, /order .* to/, /stock/, /modify/, /update data/],
  priority: 8,
  answer(query) {
    const q = normalize(query);
    let match;

    if ((match = /approve user #?(\d+)/.exec(q))) {
      return {
        answer: `I will propose approving user #${match[1]}. Review the confirmation card before applying.`,
        intent: "proposal",
        proposal: { action: "approveUser", params: { userId: Number(match[1]) } }
      };
    }
    if ((match = /revoke user #?(\d+)/.exec(q))) {
      return {
        answer: `I will propose revoking user #${match[1]}. Review the confirmation card before applying.`,
        intent: "proposal",
        proposal: { action: "revokeUser", params: { userId: Number(match[1]) } }
      };
    }
    if ((match = /unban ([\w.:-]+)/.exec(q))) {
      return {
        answer: `I will propose lifting the ban on ${match[1]}.`,
        intent: "proposal",
        proposal: { action: "unbanIp", params: { ip: match[1] } }
      };
    }
    if ((match = /set order (\d+) to (to_order|completed)/.exec(q))) {
      return {
        answer: `I will propose setting order item #${match[1]} to ${match[2]}.`,
        intent: "proposal",
        proposal: { action: "setOrderStatus", params: { itemId: Number(match[1]), status: match[2] } }
      };
    }
    if ((match = /set stock of (\d+) to (\d+)(?: reorder (\d+))?/.exec(q))) {
      return {
        answer: `I will propose updating stock for item #${match[1]}.`,
        intent: "proposal",
        proposal: {
          action: "updateStock",
          params: {
            itemId: Number(match[1]),
            stockQty: Number(match[2]),
            reorderThreshold: Number(match[3] || 0)
          }
        }
      };
    }

    return {
      answer:
        "I can prepare these admin data changes for your approval:\n" +
        listActions().map((action) => `• ${action.label} (${action.id})`).join("\n") +
        "\n\nExamples: \"approve user 3\", \"revoke user 4\", \"unban 1.2.3.4\", \"set order 12 to completed\", \"set stock of 7 to 40 reorder 10\". Nothing is written until you approve the proposal.",
      intent: "change-help"
    };
  }
};
