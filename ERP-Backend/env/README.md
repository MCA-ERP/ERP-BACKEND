# Environments (API)

One file per environment. The real files (`.env.dev`, `.env.uat`, `.env.preprod`, `.env.prod`) are private and never
committed. The `.example` files are the templates and are committed.

| Environment | Used for | Run | Run the built API | Database migrations |
|---|---|---|---|---|
| dev | your own computer | `npm run dev:dev` | `npm run start:dev` | `npm run migrate:dev` |
| uat | testing with the team | `npm run dev:uat` | `npm run start:uat` | `npm run migrate:uat` |
| preprod | final check before live | `npm run dev:preprod` | `npm run start:preprod` | `npm run migrate:preprod` |
| prod | live | `npm run dev:prod` | `npm run start:prod` | `npm run migrate:prod` |

`start:*` runs the compiled code, so run `npm run build` first. On a server, use `start:<environment>`.

Each environment should have its **own Supabase project** and its own keys. The runner refuses to start a live
environment (uat, preprod, prod) that still points at localhost or has an address that is not https.

Missing file? `copy env\.env.uat.example env\.env.uat`, then fill it in.
