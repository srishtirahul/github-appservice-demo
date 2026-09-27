# Azure POC → Production Architecture Guide

## PHASE 2: Production-Grade Architecture (Cloud Architect view)

Aapka POC teen simple pieces mein hai — frontend App Service, backend App Service, Azure SQL. Production mein hum isi POC ke around layers add karte hain, POC ka code change nahi hota, sirf network aur security ki "skin" chadhti hai.

### Traffic flow (end state)

```
User
  │
  ▼
Azure DNS (custom domain) ──► Azure Front Door / CDN (edge, WAF-lite, caching)
                                        │
                                        ▼
                          Azure Application Gateway (WAF_v2, regional)
                                        │
                         ┌──────────────┴───────────────┐
                         ▼                               ▼
              Frontend App Service              Backend App Service
              (Private Endpoint)                (Private Endpoint)
                                                          │
                                                          ▼
                                          Private Endpoint → Azure SQL Database
                                                          │
                                                          ▼
                                                  Azure Key Vault
                                          (DB connection string, certs — accessed
                                           via App Service Managed Identity)
```

### 1. DNS & Traffic Routing — Azure DNS
- Apna domain (e.g. `contoso.com`) ek Azure DNS zone mein host karein.
- `app.contoso.com` ke liye CNAME record → Front Door/CDN endpoint pe point karein.
- Agar multi-region setup hai, Traffic Manager ya Front Door ka built-in routing (priority/weighted/latency) use karein — Front Door hone par separate Traffic Manager usually zaroori nahi.

### 2. Edge & CDN — Azure Front Door (recommended over classic CDN)
- Front Door static frontend content cache karta hai edge locations pe, aur backend App Gateway ko origin banata hai.
- TLS termination edge pe hoti hai; managed certificate use karein custom domain ke liye.
- Front Door apna basic WAF bhi rakhta hai (rate limiting, geo-filtering) — yeh App Gateway WAF se pehli layer hai.

### 3. Load Balancing & Routing — Application Gateway (WAF_v2)
- App Gateway regional load balancer hai, jo Front Door se traffic leta hai aur do backend pools banata hai:
  - Pool A → Frontend App Service
  - Pool B → Backend App Service (path-based routing rule: `/api/*` → backend pool, baaki sab → frontend pool)
- WAF_v2 SKU enable karein, OWASP 3.2 ruleset, Prevention mode.
- Health probes App Service ke `/` (frontend) aur `/api/health` (backend) endpoint pe configure karein.

### 4. Network Isolation — Hub-Spoke + Private Endpoints + NSGs
- **Hub VNet**: shared services (Azure Firewall/Bastion, App Gateway) yahan rehte hain.
- **Spoke VNet**: App Services (via VNet Integration) aur Private Endpoints yahan hote hain.
- Hub aur Spoke VNet Peering se connected hote hain.
- **App Services**: "Regional VNet Integration" se spoke subnet mein outbound bhejte hain; inbound ke liye Private Endpoint subnet mein enable karein taaki App Gateway inhe private IP pe hit kare, public internet se directly access band ho.
- **Azure SQL**: Public network access = **Disabled**; sirf Private Endpoint (spoke subnet mein) se accessible — koi bhi public IP se connect nahi kar sakta.
- **NSGs**: har subnet pe attach karein —
  - App Gateway subnet: sirf Front Door/internet se 443 allow, GatewayManager tag allow (required).
  - App Service integration subnet: sirf App Gateway subnet se inbound allow.
  - Private Endpoint (SQL) subnet: sirf App Service subnet se 1433 allow.

### 5. Secrets Management — Azure Key Vault
- DB connection string, admin credentials, aur TLS certs Key Vault mein store karein.
- Dono App Services pe **System-Assigned Managed Identity** enable karein.
- Key Vault Access Policy (ya RBAC role "Key Vault Secrets User") us Managed Identity ko assign karein.
- App Service Configuration mein connection string ki jagah Key Vault reference daalein:
  `@Microsoft.KeyVault(SecretUri=https://<vaultname>.vault.azure.net/secrets/DbConnectionString/)`
- Key Vault ka public access bhi Private Endpoint se restrict kar sakte hain (optional extra layer).

---

## PHASE 3: Step-by-Step Azure Portal Implementation

> Order important hai — SQL aur networking pehle, phir App Services, phir Gateway, sabse last mein Front Door/DNS (kyunki upstream origin ready hona chahiye).

### Step 1 — Resource Group & VNets
1. Portal → **Resource groups** → Create → naam `rg-poc-prod`, region select karein.
2. **Virtual networks** → Create → `vnet-hub` (address space `10.0.0.0/16`), subnet `snet-appgw` (`10.0.1.0/24`).
3. Dusra VNet → `vnet-spoke` (`10.1.0.0/16`), subnets: `snet-appservices` (`10.1.1.0/24`), `snet-privateendpoints` (`10.1.2.0/24`).
4. Dono VNets ke **Peerings** blade mein jaake dono directions mein peering create karein ("Allow forwarded traffic" tick karein).

### Step 2 — Azure SQL Database (Private only)
1. **Azure SQL** → Create database → new server banayein → Authentication: SQL auth, strong admin password set karein.
2. **Networking** tab: "Public network access" = **Disabled**. Yahin se "Private endpoint" add karein → `vnet-spoke` / `snet-privateendpoints` select karein.
3. Deploy hone ke baad, Query Editor (Portal se access ke liye temporarily public access ON karke) ya jump-box se `database/schema.sql` run karein — ya App Service se hi deploy ke baad ek one-time script chala dein.
4. Deploy hone ke baad Public network access wapas **Disabled** kar dein.

### Step 3 — Key Vault
1. **Key Vault** → Create → naam `kv-poc-prod`.
2. **Secrets** → Generate/Import → `DbConnectionString` naam se full connection string add karein.
3. Access configuration: "Azure role-based access control" select karein (RBAC model).

### Step 4 — App Services (Frontend + Backend)
1. **App Service** → Create → `app-poc-frontend`, Runtime: Node/Static, region same as VNet, Plan: P1v3 (production tier, availability zones support ke liye).
2. Dusra: `app-poc-backend`, Runtime: Node 20 LTS.
3. Har App Service ke **Networking** blade mein "VNet integration" → `vnet-spoke` / `snet-appservices` connect karein (outbound).
4. **Identity** blade → System-assigned → **On**. Save.
5. Backend App Service ke **Configuration → Application settings** mein Key Vault reference daalein:
   - Name: `DB_CONNECTION_STRING`, Value: `@Microsoft.KeyVault(SecretUri=https://kv-poc-prod.vault.azure.net/secrets/DbConnectionString/)`
6. Key Vault → **Access control (IAM)** → Add role assignment → "Key Vault Secrets User" → Managed identity → dono App Services select karein.
7. Deploy code: **Deployment Center** blade se GitHub/local git/zip deploy use karein (backend ka `server.js`+`package.json`, frontend ka `index.html`).
8. Inbound restrict karne ke liye App Service ke **Networking → Private endpoints** se ek Private Endpoint add karein `snet-privateendpoints` mein, aur "Access Restrictions" mein public access deny + App Gateway subnet allow set karein.

### Step 5 — Application Gateway (WAF_v2)
1. **Application Gateway** → Create → tier: **WAF V2**, VNet: `vnet-hub`, subnet: `snet-appgw`.
2. **Frontend**: Public IP create karein (Standard SKU).
3. **Backend pools**: do pools banayein — `pool-frontend` (target: frontend App Service's private endpoint/FQDN), `pool-backend` (backend App Service's FQDN).
4. **Configuration (routing rules)**:
   - Listener: HTTPS 443, upload/select TLS cert (ya Key Vault se cert reference).
   - Rule 1: path pattern `/api/*` → `pool-backend`, HTTP settings port 443, "Override with new hostname" ON.
   - Rule 2 (default): `/*` → `pool-frontend`.
5. **HTTP settings** mein backend App Service ka "Host name" override karke App Service ka default domain daalein (App Service hostname header verify karta hai).
6. **Health probes**: custom probe `/api/health` (backend) aur `/` (frontend) add karke respective HTTP settings se attach karein.
7. **WAF configuration**: Mode = **Prevention**, Ruleset = OWASP 3.2, enable.

### Step 6 — Front Door / CDN
1. **Front Door and CDN profiles** → Create → Standard/Premium tier (Premium if Private Link to App Gateway chahiye).
2. **Endpoint** add karein, **Origin group** create karein jiska origin = App Gateway ka public IP/FQDN.
3. **Route**: pattern `/*`, origin group attach, "Forwarding protocol" = HTTPS only, caching enable karein static assets ke liye (frontend path).
4. Custom domain add karein (`app.contoso.com`), managed TLS certificate issue hone dein.

### Step 7 — Azure DNS
1. **DNS zone** → apna domain add/verify karein (registrar pe nameservers update karein agar Azure DNS pe migrate kar rahe hain).
2. CNAME record: `app` → Front Door endpoint hostname (e.g. `xxxx.z01.azurefd.net`).
3. Front Door mein domain ka DNS validation TXT record bhi add karein jab tak custom domain "Approved" na ho jaaye.

### Step 8 — NSGs
1. `snet-appgw` pe NSG create/attach karein: Inbound allow 443 from Internet (ya sirf Front Door IP ranges), allow 65200-65535 from GatewayManager (App Gateway v2 requirement).
2. `snet-appservices` pe NSG: Inbound allow only from `snet-appgw` range.
3. `snet-privateendpoints` pe NSG: Inbound allow 1433 only from `snet-appservices` range.

### Step 9 — Verification (User → SQL)
1. Browser mein `https://app.contoso.com` kholein → DNS resolve karke Front Door tak jaana chahiye (check via `nslookup`/browser dev tools → Network tab mein response headers mein `X-Azure-Ref` dikhega, confirm Front Door hit hua).
2. Frontend load hone ke baad "Add Item" karke dekhein — dev tools Network tab mein request `/api/items` App Gateway ke path rule se hoke backend App Service tak jaani chahiye.
3. Backend App Service ke **Log stream** mein confirm karein request receive hui aur DB query chali.
4. Azure SQL ke **Metrics** blade mein "Connections" spike check karein — sirf Private Endpoint se traffic aana chahiye (public access disabled hone ke bawajood app kaam kar raha ho, iska matlab Private Endpoint path sahi hai).
5. End-to-end trace ke liye App Gateway ke **Access logs** aur Front Door ke **Logs** dono enable karke correlate karein.

---

**Nott:** Phase 1 ka code isi guide ke saath diya gaya hai (`backend/`, `frontend/`, `database/schema.sql`). Deploy karne se pehle local testing kar lein — `npm install` backend folder mein, `.env` file `.env.example` se banayein.
