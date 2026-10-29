/** No built-in default: the real MCP endpoint is an internal routing detail
 *  that must not be hardcoded into a publicly distributed plugin. Users must
 *  fill this in themselves on the settings page. */
export const DEFAULT_ENDPOINT = "";
export const DEFAULT_PROPERTY_KEY = "iwiki_url";
export const DEFAULT_TITLE_PROPERTY_KEY = "iwiki_title";

export interface IwikiSyncSettings {
  /** Must always be an https:// URL — enforced at the point of mutation, not just on read. */
  endpoint: string;
  propertyKey: string;
  titlePropertyKey: string;
  /**
   * Name of the secret already stored by the user in Obsidian's
   * SecretStorage (e.g. "iwiki-pat"), picked via the native secret
   * reference control. This is a reference only — never the token value
   * itself — so it is safe to persist in data.json.
   */
  patSecretName: string | undefined;
}

/** Default secret reference name; the user still has to actually create
 *  this secret in Obsidian's SecretStorage themselves — this is only a
 *  convenient pre-filled reference, not an auto-created secret. */
export const DEFAULT_PAT_SECRET_NAME = "iwiki-pat";

export const DEFAULT_SETTINGS: IwikiSyncSettings = {
  endpoint: DEFAULT_ENDPOINT,
  propertyKey: DEFAULT_PROPERTY_KEY,
  titlePropertyKey: DEFAULT_TITLE_PROPERTY_KEY,
  patSecretName: DEFAULT_PAT_SECRET_NAME,
};
