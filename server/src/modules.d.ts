// Files the Worker bundles as text (wrangler's default module rules): the OpenBelt app paperbot deploys (src/items.ts).
declare module "*.html" { const text: string; export default text; }
