import { defineConfig } from "wxt";

function configuredApiHostPermission(): string[] {
  const configured = process.env.WXT_API_BASE_URL?.trim();
  if (!configured) return [];

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("WXT_API_BASE_URL must be an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WXT_API_BASE_URL must use http or https.");
  }
  return [`${url.protocol}//${url.host}/*`];
}

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Perspectica",
    description: "See the article's political framing, bias signals, and evidence.",
    version: "0.1.0",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlteXkwfojyCDERbAR/WNVJrug3V3/zTJDSiVkRSa2RCzTZIBilhFhFx4yzi2T7azHK5r4ms5h9XMGzJ+UOfiUi8bW1M7BTR4rntFVCLuxMxIVLHLfBjaSekLHnbSUO+DlC7i0yOBAa4ApTrUQRJYuIsCUdEwy4yc0etvnlhf3dphgXeqnZw6AhZlEsZHgEnWDj9Y0lJQ+HyEKB9Xs0bygoQfvl1mSEMWfy/SwZ43aVBgx1anhtDRbieGxoM+opSSitl4kMiQ7/TOzQ2ZIz/fuKFQa5PXnluGutPzW6JDhBZ/jHDcfn8fiAhm2DZYuiR4Ki2UDEfI7H8ziI70v5EGnQIDAQAB",
    permissions: ["activeTab", "tabs"],
    host_permissions: ["http://localhost:3000/*", ...configuredApiHostPermission()],
    action: {
      default_title: "Open Perspectica",
    },
  },
});
