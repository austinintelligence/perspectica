import {
  DEFAULT_EXTENSION_PREFERENCES,
  ExtensionPreferencesSchema,
  type ExtensionPreferences,
} from "../runtime/messages";
import type { JsonStorageArea } from "./areas";

const PREFERENCES_KEY = "perspectica.preferences.v2";

export class PreferencesStore {
  constructor(private readonly storage: JsonStorageArea) {}

  async get(): Promise<ExtensionPreferences> {
    const raw = await this.storage.get(PREFERENCES_KEY);
    const parsed = ExtensionPreferencesSchema.safeParse(raw);
    if (!parsed.success) return DEFAULT_EXTENSION_PREFERENCES;
    // Parsing normalizes the retired `fast` mode to canonical `quick`; persist
    // the normalized record so subsequent resume/fingerprint paths agree.
    if (JSON.stringify(raw) !== JSON.stringify(parsed.data))
      await this.storage.set(PREFERENCES_KEY, parsed.data);
    return parsed.data;
  }

  async set(preferences: ExtensionPreferences): Promise<void> {
    await this.storage.set(PREFERENCES_KEY, ExtensionPreferencesSchema.parse(preferences));
  }
}
