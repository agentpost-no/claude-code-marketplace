import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agentpostChannelPlugin } from "./src/channel.js";
import { createAgentpostService } from "./src/service.js";

export default defineChannelPluginEntry({
	id: "agentpost",
	name: "Agentpost",
	description: "Email channel for agents. Inbound mail is sealed to the agent's key; the owner approves outbound.",
	plugin: agentpostChannelPlugin,
	registerFull(api) {
		// Only the full runtime opens sockets; discovery and setup modes must not.
		api.registerService(createAgentpostService(api));
	},
});
