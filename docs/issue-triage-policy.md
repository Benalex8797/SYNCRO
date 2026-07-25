# Issue Triage & Backlog Governance Policy

This document defines the policy, workflows, and responsibilities for managing the SYNCRO issue backlog. Ensuring a structured, noise-free backlog is vital for team velocity and codebase quality.

---

## 1. Issue Taxonomy Reference

All issues must be labeled according to the categories defined in [.github/labels.yml](file:///C:/Users/fuhad/SYNCRO/.github/labels.yml):

| Category | Label Prefix | Purpose |
| :--- | :--- | :--- |
| **Area** | `area/` | Maps the issue to code ownership boundaries (e.g., `client`, `backend`, `contracts`). |
| **Priority** | `priority/` | Defines the urgency and scheduling target (`P0` to `P3`). |
| **Type** | `type/` | Indicates the kind of work (e.g., `bug`, `feature`, `refactor`, `security`). |
| **Risk** | `risk/` | Evaluates the blast radius and testing complexity (`low`, `medium`, `high`). |
| **Status** | `status/` | Tracks the lifecycle of the issue (`triage`, `backlog`, `in-progress`, etc.). |

---

## 2. Intake expectations

### Submission
- All new issues must use the official issue templates defined in [.github/ISSUE_TEMPLATE/](file:///C:/Users/fuhad/SYNCRO/.github/ISSUE_TEMPLATE/).
- New issues are automatically assigned the `status/triage` label upon creation.

### Initial Triage Workflow
- **Frequency:** The triage team reviews new issues daily.
- **Verification:** For bug reports, the triager must verify the reproduction steps. If the issue is incomplete, they should request clarification and mark the issue as `status/blocked`.
- **Classification:** Every triaged issue must have at least one label from each of the following groups before entering the backlog:
  - `area/` (matching the code ownership boundaries)
  - `priority/` (based on urgency)
  - `type/` (based on classification)
  - `risk/` (based on blast radius)
- **Response Targets (SLAs):**
  - **Priority P0:** Must be triaged within **2 hours** of submission.
  - **Priority P1:** Must be triaged within **12 hours** of submission.
  - **Other Priorities:** Must be triaged within **48 hours** of submission.

---

## 3. Grooming Expectations

Backlog grooming ensures that the backlog remains relevant, prioritized, and actionable.

### Grooming Cadence
- **Weekly Grooming Session:** The product owners, tech leads, and maintainers meet weekly to groom the backlog.
- **Bi-weekly Sprint Planning:** Prioritized tasks are pulled from `status/backlog` into active sprints.

### Definition of Ready (DoR)
Before an issue is moved from `status/backlog` to `status/in-progress` (ready for assignment), it must satisfy the following criteria:
1. **Clear Scope:** The description clearly details the problem and expected behavior.
2. **Acceptance Criteria:** A checklist of functional and non-functional requirements.
3. **Labels Applied:** Complete taxonomy categorization.
4. **No Blockers:** The issue is not blocked by other unresolved issues.

### Re-evaluation and Risk Management
- If an issue is classified as `risk/high`, it requires:
  - Architectural review by the primary owner before development starts.
  - A designated test plan in the acceptance criteria.
- If an issue spans multiple code ownership areas, co-owners must be tagged in the description to coordinate review requirements.

---

## 4. Closure Expectations

Issues must follow a formal closure process to guarantee quality control and maintain repository cleanliness.

### Criteria for Closure
An issue can be closed under the following conditions:
1. **PR Merged:** A pull request addressing the issue has been successfully reviewed, approved, and merged to the main branch. The PR description must link back to the issue using standard keywords (e.g., `Closes #114`).
2. **Duplicate:** The issue is a duplicate of an existing issue. It must be linked, labeled `status/wontfix`, and closed.
3. **Out of Scope/Wontfix:** The issue is rejected by maintainers. A comment explaining the reasoning must be posted, the issue labeled `status/wontfix`, and closed.

### Stale Issue Management
- Issues with no activity (comments, edits, or assignments) for **60 days** will be marked as stale with a warning comment.
- If no activity occurs for another **14 days**, the issue will be closed with `status/wontfix`.

### Long-form Implementation Artifacts
- As outlined in [CONTRIBUTING.md](file:///C:/Users/fuhad/SYNCRO/CONTRIBUTING.md#L195-L197), all long-form implementation artifacts, summaries, or delivery notes must be stored in the `docs/archive/` directory rather than the repository root. This ensures that active project entrypoints remain clean.

---

## 5. Contact and Escalation

For questions about this policy or to request expedited triage of a blocker, contact the DevOps team or ping the maintainers (see [.github/CODEOWNERS](file:///C:/Users/fuhad/SYNCRO/.github/CODEOWNERS)).
