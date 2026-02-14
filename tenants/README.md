# Tenant Fixtures

This directory contains JSON fixture files for pre-configured demo tenants.

## Usage

### Seed a Tenant from a Fixture

```bash
cd src/backend
npx tsx src/db/seed.ts                              # Seeds the default demo-clinic
npx tsx src/db/seed.ts --fixture ../../tenants/demo-gomomo-clinic.json
```

### Create a New Tenant

1. Copy an existing fixture:
   ```bash
   cp tenants/demo-clinic.json tenants/my-client.json
   ```

2. Edit the JSON — change name, slug, timezone, services, hours, etc.

3. Seed it:
   ```bash
   npx tsx src/db/seed.ts --fixture ../../tenants/my-client.json
   ```

## Fixture Schema

See [Tenant Configuration Reference](../docs/guides/tenant-configuration.md) for the
full schema documentation with all fields, types, and defaults.

## Files

| Fixture | Description |
|---|---|
| `demo-gomomo-clinic.json` | gomomo Demo Clinic — sample tenant for demos and sales presentations. 3 services, Saturday hours. |
| `demo-clinic.json` | Demo Clinic — minimal setup. 3 services, Mon–Fri only. Default persona. Used for development and testing. |
