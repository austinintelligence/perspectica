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
    const parsed = ExtensionPreferencesSchema.safeParse(await this.storage.get(PREFERENCES_KEY));
    return parsed.success ? parsed.data : DEFAULT_EXTENSION_PREFERENCES;
  }

  async set(preferences: ExtensionPreferences): Promise<void> {
    await this.storage.set(PREFERENCES_KEY, ExtensionPreferencesSchema.parse(preferences));
  }
}
