import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agentpostChannelPlugin } from "./src/channel.js";
import { setPluginApi } from "./src/gateway.js";

export default defineChannelPluginEntry({
	id: "agentpost",
	name: "Agentpost",
	description: "Email channel for agents. Inbound mail is sealed to the agent's key; the owner approves outbound.",
	plugin: agentpostChannelPlugin,
	registerFull(api) {
		// The connection itself is owned by the channel gateway adapter, which OpenClaw
		// starts per account; this only hands it the runtime it dispatches through.
		setPluginApi(api);
	},
});
