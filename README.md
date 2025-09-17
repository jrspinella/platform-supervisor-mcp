Part A — Platform Engineer flow

A1. Governance deny (fast check)

You say (in Copilot):

@platform Create a resource group named rg-cookies in usgovvirginia.

Expect: Governance DENY (name blacklist) + suggestion.

⸻

A2. Resource Group (plan → confirm)

You say:

@platform Ok, Create a resource group named rg-ml-sbx-jrs in usgovvirginia with tags owner is jrspinella@live.com and env is dev. 

Then:

Confirm yes.

Expect: ✅ Success (with masked subscription).

⸻

A3. App Service Plan (plan → confirm)

You say:

@platform Create an App Service Plan plan-ml-sbx-jrs in rg-ml-sbx-jrs in location usgovvirginia with SKU P5v3.

Expect: Governance DENY (SKU blacklist) + suggestion.

Then:

@platform Ok, create an App Service Plan plan-ml-sbx-jrs in rg-ml-sbx-jrs, location usgovvirginia, SKU P1

⸻

A4. Web App (plan → confirm)

You say:

Create a Web App web-ml-sbx-jrs on plan plan-ml-sbx-jrs in rg-ml-sbx-jrs, location usgovvirginia, runtime NODE|20-lts.

Then:

Confirm yes.

Expect: May see ATO WARN (HTTPS-only, min TLS, diagnostics). That’s advisory.

⸻

A5. Enable Managed Identity

You say:

Enable system-assigned identity for web-ml-sbx-jrs in rg-ml-sbx-jrs.

⸻

A6. Storage & Log Analytics

You say:

Create a Storage Account stmlsbxjrs01 in rg-ml-sbx-jrs location usgovvirginia, sku Standard_LRS, kind StorageV2.

Then:

Confirm yes.

You say:

Create a Log Analytics workspace law-ml-sbx-jrs in rg-ml-sbx-jrs, retention 30 days.

⸻

A7. ATO scan — workloads (read-only)

You say:

Scan App workloads in rg-ml-sbx-jrs for ATO warnings.

Expect: Short findings list (e.g., HTTPS-only/TLS/diagnostics). No raw JSON.

(Optional remediation if you wired config tools)
You say:

Enable HTTPS-only and set minimum TLS version 1.2 for web-ml-sbx-jrs. Confirm yes.

⸻

Part B — Developer flow

B1. Repository from template (plan → confirm)

You say:

Create a new repo ml-svc-jdoe in org navy-dev from the template navy-platform/web-node-api, make it private, description “ML service API”. Plan only.

Then:

Confirm yes.

Expect: ✅ Repo URL returned.

⸻

B2. Static Web App (plan → confirm)

You say:

Create a Static Web App swa-ml-sbx-jrs in rg-ml-sbx-jrs, location usgovvirginia, sku Free. Plan only.

Then:

Confirm yes.

⸻

B3. Link SWA to repo (plan → confirm)

You say:

Link swa-ml-sbx-jrs in rg-ml-sbx-jrs to navy-dev/ml-svc-jdoe on branch main, appLocation “/”, output “dist”. Plan only.

Then:

Confirm yes.

Expect: Notes about GitHub Actions workflow & token secret needs.

⸻

Part C — Onboarding (natural language)

C1. Dry run preview

You say:

Onboard jdoe@contoso.gov alias jdoe in usgovvirginia. Dry run only.

Expect: Checklist preview + confirm hint.

⸻

C2. Execute onboarding

You say:

Execute the onboarding checklist for jdoe@contoso.gov alias jdoe in usgovvirginia. Confirm yes, dry run false.

Expect: ✅ Task-by-task summary with any governance advisories.

⸻

Part D — (Optional) ATO scan networks

(Run if you already have VNets/Subnets/NSGs in the RG)

You say:

Scan networks in rg-ml-sbx-jrs for ATO warnings.

Expect: Findings referencing private endpoints, NSG rules, public IPs, with remediation pointers.

⸻

Part E — Wrap-up

You say:

Summarize everything created today and list any remaining ATO warnings with fixes.

Expect: High-level recap (masked IDs), remaining actions (HTTPS/TLS/Diagnostics/PE), and quick-fix guidance.   Developer Flow (using PeDemoOrg/ModernUIRepository)

Option 1 — Use it as the template source

B1. Create repo from template (plan → confirm)

Create a new repo modern-ui-sbx-jdoe in org PeDemoOrg from the template PeDemoOrg/ModernUIRepository, make it private, description “Modern UI service (sandbox) for jdoe”. Plan only.

Confirm yes.

B2. Create Static Web App (plan → confirm)

Create a Static Web App swa-modern-ui-jdoe in rg-ml-sbx-jrs, location usgovvirginia, sku Free. Plan only.

Confirm yes.

B3. Link SWA to the new repo (plan → confirm)

Link swa-modern-ui-jdoe in rg-ml-sbx-jrs to PeDemoOrg/modern-ui-sbx-jdoe on branch main, appLocation “/”, output “dist”. Plan only.

Confirm yes.

⸻

Option 2 — Treat PeDemoOrg/ModernUIRepository as an existing repo

B1’. (Skip template) Just validate repo exists

Check if the GitHub repo PeDemoOrg/ModernUIRepository exists and summarize the default branch and last commit.

B2’. Create Static Web App (plan → confirm)

Create a Static Web App swa-modern-ui in rg-ml-sbx-jrs, location usgovvirginia, sku Free. Plan only.

Confirm yes.

B3’. Link SWA to existing repo (plan → confirm)

Link swa-modern-ui in rg-ml-sbx-jrs to PeDemoOrg/ModernUIRepository on branch main, appLocation “/”, output “dist”. Plan only.

Confirm yes.

⸻

Optional GitHub hardening (nice for managers to see)

For PeDemoOrg/modern-ui-sbx-jdoe, enable branch protection on main requiring PR reviews and status checks, and enable Dependabot security updates. Plan only.

Confirm yes.

⸻

Optional: ATO scan after deployment linkage

Scan App workloads in rg-ml-sbx-jrs for ATO warnings and list fixes only (no raw JSON).


Platform (Azure) — create / scan / remediate

Create (single resources)
	•	@platform create a resource group rg-ml-sbx-jrs in usgovvirginia with tags owner is jrs@live.com and env is dev
	•	@platform create an App Service Plan plan-ml-sbx-jrs in rg-ml-sbx-jrs in location usgovvirginia with SKU P1v3
	•	@platform create a Web App web-ml-sbx-jrs on plan plan-ml-sbx-jrs in rg-ml-sbx-jrs, location usgovvirginia, runtime NODE|20-lts, https-only, tls 1.2, ftps disabled
	•	(JSON-ish tags also work)
@platform create resource group rg-demo in usgovvirginia with tags {"owner":"alice@example.com","env":"dev"}

Create (multi-step; goes through the planner & runs platform.apply_plan)
	•	@platform create a resource group rg-ml-sbx-01 in usgovvirginia with tags owner is bob@agency.gov and env is dev, then create an App Service Plan plan-ml-sbx-01 P1v3 in that RG, then create a Web App web-ml-sbx-01 on that plan runtime NODE|20-lts
	•	@platform build a new azure workload: RG rg-app-sbx in usgovvirginia → plan plan-app-sbx P1v3 → web web-app-sbx runtime DOTNET|8.0 (https-only, tls 1.2, ftps disabled)

Scan
	•	@platform scan web app web-ml-sbx-jrs in rg-ml-sbx-jrs for ATO
	•	@platform scan app service plan plan-ml-sbx-jrs in rg-ml-sbx-jrs
	•	@platform scan app workloads in rg-ml-sbx-jrs for ATO warnings  ← (filters to web apps + plans)
	•	@platform scan resource group rg-ml-sbx-jrs

Remediate
	•	After any scan, you’ll see buttons. You can also ask explicitly:
@platform plan remediation for web-ml-sbx-jrs in rg-ml-sbx-jrs
@platform apply remediation for web-ml-sbx-jrs in rg-ml-sbx-jrs
	•	Or target a code directly when you know it:
@platform remediate_webapp_baseline {"resourceGroupName":"rg-ml-sbx-jrs","name":"web-ml-sbx-jrs","dryRun":true}

Policy / ATO
	•	@platform policy reload from dir ./governance-policy
	•	@platform policy dump
	•	Switch profile per call:
@platform scan resource group rg-ml-sbx-jrs with profile highbar

Other Azure bits (if you wired them)
	•	@platform create storage account stjrs123 in rg-ml-sbx-jrs location usgovvirginia (https-only)
	•	@platform create key vault kv-jrs in rg-ml-sbx-jrs location usgovvirginia rbac enabled public network disabled
	•	@platform create virtual network vnet-jrs in rg-ml-sbx-jrs location usgovvirginia address 10.20.0.0/16

Mission Owner (GitHub + Azure) — repos, envs, CI/CD

End-to-end developer environment
	•	@missionowner create a private repo org:my-org name:ml-api, add a dev environment, OIDC to Azure, and provision RG rg-ml-api in usgovvirginia with plan plan-ml-api (P1v3) and web web-ml-api (NODE|20-lts)
	•	@missionowner provision a developer environment for repo my-org/payments: create RG rg-payments-dev in usgovvirginia, plan plan-payments-dev P1v3, web web-payments-dev runtime NODE|20-lts; add GitHub Actions workflow for deploy

GitHub operations
	•	@missionowner create a repo org:my-org name:ml-service visibility private with branch protection main
	•	@missionowner add secrets to repo my-org/ml-service: AZURE_CLIENT_ID=…, AZURE_TENANT_ID=…, AZURE_SUBSCRIPTION_ID=…
	•	@missionowner add a GitHub Actions workflow to build & deploy the web app web-ml-sbx-jrs to rg-ml-sbx-jrs

Scan & remediate (mission)
	•	@missionowner scan repo my-org/ml-service for CI policy
	•	@missionowner remediate plan for repo my-org/ml-service
	•	@missionowner remediate apply for repo my-org/ml-service

“Shape” hints the router/planner understands
	•	Create verbs: create, provision, build
	•	Scanning: scan, and the special phrasing “app workloads” to scan only web apps + app plans in an RG.
	•	Chaining: “… then create …” or “… and then …” triggers the multi-step planner.
	•	Regions: Prefer usgovvirginia for US Gov unless you say otherwise.
	•	Runtime: use exact strings like NODE|20-lts, DOTNET|8.0.
	•	SKU: P1v3, P2v3, S1, etc. The router catches sku, tier, size, or bare tokens.
	•	Tags: phrase as with tags owner is a@b and env is dev or with tags {"owner":"a@b","env":"dev"}.

Troubleshooting prompts
	•	“why did that step fail?”
	•	“plan remediation for previous findings”
	•	“re-run the scan for rg-ml-sbx-jrs”
	•	“show policy warnings for azure.create_web_app”
	•	“reload policy from ./policy and re-scan rg-ml-sbx-jrs”