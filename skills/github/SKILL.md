---
name: github
description: GitHub workflow — creating and managing repos, always working on feature/development branches (never committing core changes directly to main), PR conventions, branch protection, and gh CLI patterns
keywords: ["github", "pr", "cli", "workflow", "creating", "managing", "repos", "always", "working", "feature/development", "branches", "never", "committing", "core", "changes", "directly", "main"]
orb_class: planet
---

# github

Git and GitHub discipline for solo and team projects. Core rule: **main is always deployable. Every meaningful change lands via a feature branch and PR.**

## 1) Branch Strategy

```
main                    ← production-ready, protected, never commit directly
  └── development       ← integration branch (optional, for staging)
        └── feature/    ← one branch per feature / fix / refactor
            bugfix/
            chore/
```

**Always create a branch before writing code:**
```bash
git checkout -b feature/add-email-capture
git checkout -b bugfix/fix-jwt-expiry
git checkout -b chore/update-dependencies
```

**After every core change — commit and push to the branch:**
```bash
git add src/email-capture.py tests/test_email_capture.py
git commit -m "feat: add ConvertKit email capture integration"
git push origin feature/add-email-capture
```

## 2) New Repo Setup (gh CLI)

```bash
# Create repo on GitHub from existing local directory
cd /opt/myproject
git init
git add .
git commit -m "chore: initial project scaffold"

# Create GitHub repo (private by default)
gh repo create myorg/myproject --private --source=. --remote=origin --push

# Immediately create development branch
git checkout -b development
git push -u origin development

# Set default branch to development in GitHub
gh repo edit myorg/myproject --default-branch development
```

```bash
# Clone existing repo and set up branch
gh repo clone myorg/myproject /opt/myproject
cd /opt/myproject
git checkout -b feature/my-feature
```

## 3) Existing Repo — Before Any Change

```bash
# Always start from latest main
git checkout main
git pull origin main

# Create feature branch
git checkout -b feature/ringba-call-tracking

# Work... then push
git push -u origin feature/ringba-call-tracking
```

**Never:**
```bash
git checkout main
# make changes
git commit -m "add feature"   # ❌ committing to main
git push origin main          # ❌ pushing to main directly
```

## 4) Commit Message Convention

```
<type>: <short description>

Types:
  feat:     new feature
  fix:      bug fix
  chore:    maintenance, deps, config
  refactor: restructure without behavior change
  test:     add or update tests
  docs:     documentation only
  ci:       CI/CD changes
```

```bash
# Good commit messages:
git commit -m "feat: add Ringba call tracking to theme header"
git commit -m "fix: JWT token not refreshing on 401 response"
git commit -m "chore: bump astro to 4.15.2"
git commit -m "test: add unit tests for email normalization"

# Bad:
git commit -m "update"           # ❌ no context
git commit -m "fix bug"          # ❌ which bug?
git commit -m "WIP"              # ❌ never push WIP to shared branches
```

## 5) Pull Request Workflow

```bash
# Open PR from feature branch → development (or main)
gh pr create \
  --title "feat: add email capture with ConvertKit" \
  --body "$(cat <<'EOF'
## Summary
- Add ConvertKit embed support via `kh_email_capture_shortcode` option
- Render form in `email-capture.php` when shortcode is set
- Guard: renders nothing when option is empty (preserves PENDING.md contract)

## Test plan
- [ ] Set option via WPCode, verify form renders
- [ ] Leave option empty, verify no output
- [ ] Check mobile layout at 375px

🤖 Generated with Claude Code
EOF
)" \
  --base development

# Review and merge
gh pr view --web   # open in browser
gh pr merge 42 --squash --delete-branch
```

## 6) Branch Protection (set once per repo)

```bash
# Protect main — require PR, no direct push
gh api repos/myorg/myproject/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["ci/lint-and-test"]}' \
  --field enforce_admins=false \
  --field required_pull_request_reviews='{"required_approving_review_count":1}' \
  --field restrictions=null

# Or via UI: Settings → Branches → Add rule:
# - Branch name pattern: main
# - Require status checks: ci/lint-and-test
# - Require PR before merging
# - Do not allow bypassing the above settings
```

## 7) Everyday gh CLI Commands

```bash
# Repo
gh repo view                        # summary of current repo
gh repo view --web                  # open in browser
gh repo clone org/repo /opt/path    # clone to specific path

# Branches & PRs
gh pr list                          # open PRs
gh pr status                        # PRs relevant to current branch
gh pr checkout 42                   # check out PR locally
gh pr diff 42                       # view PR diff in terminal

# Issues
gh issue list                       # open issues
gh issue create --title "Bug: ..." --body "..."
gh issue close 17

# Releases
gh release create v1.0.0 --generate-notes
gh release view v1.0.0

# Actions / CI
gh run list                         # recent workflow runs
gh run view 123456                  # details of a run
gh run watch                        # watch current run live
```

## 8) Keeping Feature Branches Up to Date

```bash
# Rebase onto latest main (preferred over merge — keeps history clean)
git fetch origin
git rebase origin/main

# If conflicts:
git status                  # see conflicted files
# ... resolve conflicts ...
git add resolved-file.py
git rebase --continue

# Force-push is required after rebase (only on your own feature branch)
git push --force-with-lease origin feature/my-feature
```

`--force-with-lease` is safer than `--force` — it fails if someone else pushed to the branch.

## 9) Tagging Releases

```bash
# After merging to main and deploying:
git checkout main && git pull
git tag -a v1.2.0 -m "Release v1.2.0 — add email capture, call tracking"
git push origin v1.2.0

# Create GitHub release from tag
gh release create v1.2.0 \
  --title "v1.2.0 — Email capture + call tracking" \
  --generate-notes
```

## 10) Checklist

- [ ] Repo created with `gh repo create` — `.gitignore` and `LICENSE` added at init
- [ ] `development` branch created and set as default for active development
- [ ] `main` branch protected — no direct push, requires PR
- [ ] Every feature/fix starts as `feature/` or `bugfix/` branch off `main`
- [ ] Commit messages follow `<type>: <description>` convention
- [ ] `git push -u origin <branch>` after first commit on branch (sets upstream)
- [ ] PR opened to `development` (or `main`) — not committed directly
- [ ] `--squash` merge keeps main history clean
- [ ] `--delete-branch` on merge keeps remote branches tidy
- [ ] Tags created for every production release (`v1.x.x`)
