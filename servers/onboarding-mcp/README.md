# Onboarding MCP

An MCP that renders and executes onboarding playbooks. It **does not** enforce
governance directly. Each service MCP (Azure/GitHub/etc.) performs its own
governance when invoked.

## Env

- `PORT` (default `8714`)
- `ROUTER_URL` (default `http://127.0.0.1:8700`)
- `ONBOARDING_PLAYBOOK_DIR` (default `onboarding/playbooks`)
- `ONBOARDING_STATE_DIR` (default `onboarding/state`)
- `DEFAULT_REGION` (default `usgovvirginia`)
- `ONBOARDING_DEFAULT_PLAYBOOK_ID` (default `mission-owner`)

## Tools

- `onboarding.list_playbooks`
- `onboarding.get_checklist`
- `onboarding.describe_playbook`
- `onboarding.start_run`
- `onboarding.next_task`
- `onboarding.complete_task`
- `onboarding.execute_task`
- `onboarding.execute_all_pending`
- `onboarding.validate_playbooks`
- `onboarding.ping`
- `onboarding.debug_info`

## Flow

1. `onboarding.start_run { playbookId, user, region }`
2. `onboarding.get_checklist { ... }`
3. `onboarding.execute_all_pending { runId, confirm: true, dryRun: false }`  
   or execute step-by-step with `onboarding.execute_task`.

Execution calls the Router `/a2a/tools/call`, which forwards to Azure/GitHub MCPs.
Those MCPs implement their own governance checks and returns success/errors back.