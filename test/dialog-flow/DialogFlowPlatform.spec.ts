import { expect } from "chai";
import { DialogFlowPlatform } from "../../src/platforms/dialog-flow/DialogFlowPlatform";
import { DialogFlowReply } from "../../src/platforms/dialog-flow/DialogFlowReply";
import { VoxaApp } from "../../src/VoxaApp";
import { views } from "../views";

describe("DialogFlowPlatform", () => {
  describe("execute", () => {
    it("should convert the voxaReply to a Dialog Flow response", async () => {
      const rawEvent = require("../requests/dialog-flow/launchIntent.json");
      const voxaApp = new VoxaApp({ views });

      voxaApp.onIntent("LaunchIntent", () => ({ say: "LaunchIntent.OpenResponse" }));

      const platform = new DialogFlowPlatform(voxaApp);

      const reply = await platform.execute(rawEvent, {}) as DialogFlowReply;
      expect(reply.speech).to.equal("<speak>Hello from DialogFlow</speak>");
    });
  });
});
