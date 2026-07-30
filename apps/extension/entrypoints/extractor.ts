import { extractArticleDocument } from "@perspectica/extraction";

export default defineUnlistedScript(() =>
  extractArticleDocument(document, globalThis.location.href),
);
