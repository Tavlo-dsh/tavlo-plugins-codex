/**
 * Names shared by the adapter, the mirror tool and the session registry.
 * @module tavlo-plugins-codex/constants
 */

/** Provider route under which Codex appears in DSH's model menu. */
export const PROVIDER = 'codex'

/** Display name of the provider. */
export const PROVIDER_LABEL = 'Codex'

/** The record-only tool that mirrors Codex's own tool calls into DSH. */
export const MIRROR_TOOL_NAME = 'codex_tool'

/** Model id meaning "whatever Codex's own settings choose". */
export const DEFAULT_MODEL_ID = 'default'

/** Directory under the DSH home where this plugin keeps its files. */
export const PLUGIN_HOME = 'tavlo-codex'
