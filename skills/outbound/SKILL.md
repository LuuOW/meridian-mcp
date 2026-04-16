---
name: outbound
description: Outbound growth authority — cold email sequences, lead scoring, ICP definition, CRM integration, Apollo and Instantly patterns, deliverability, reply handling, and pipeline-to-revenue tracking
---

# outbound

Covers the full outbound motion: ICP definition, lead sourcing, sequence design, deliverability, and CRM pipeline management. Built from lead-gen-engine patterns.

## 1) ICP (Ideal Customer Profile) definition

```python
ICP = {
    "firmographic": {
        "company_size":   "10-200 employees",
        "industry":       ["SaaS", "eCommerce", "Agency"],
        "revenue_range":  "$1M-$50M ARR",
        "geography":      ["US", "CA", "UK", "AU"],
        "tech_stack":     ["Shopify", "HubSpot", "Salesforce"],  # technographic signals
    },
    "demographic": {
        "title":          ["Head of Marketing", "VP Growth", "Founder", "CMO"],
        "seniority":      ["Director", "VP", "C-Suite"],
        "department":     "Marketing or Growth",
    },
    "behavioural": {
        "intent_signals": ["hired growth role recently", "raised funding", "launched product"],
        "pain_signals":   ["low organic traffic", "high CAC", "content gaps"],
    },
    "negative":  {
        "exclude":        ["competitors", "agency clients", "students", "job seekers"],
    },
}
```

## 2) Lead scoring model

```python
def score_lead(lead: dict) -> float:
    score = 0.0
    # Firmographic fit (0-40 pts)
    if lead.get("company_size") in range(10, 201):    score += 15
    if lead.get("industry") in ICP["firmographic"]["industry"]:  score += 15
    if lead.get("revenue"):                            score += 10
    # Role fit (0-30 pts)
    if any(t in lead.get("title","") for t in ICP["demographic"]["title"]):  score += 20
    if lead.get("seniority") in ICP["demographic"]["seniority"]:             score += 10
    # Intent signals (0-30 pts)
    if lead.get("recent_funding"):    score += 15
    if lead.get("recent_hire"):       score += 10
    if lead.get("tech_stack_match"):  score += 5
    return score  # > 60 = hot, 40-60 = warm, < 40 = cold

BUCKETS = {"hot": 60, "warm": 40, "cold": 0}
```

## 3) Cold email sequence structure

```
Sequence: 5-touch, 14-day window

Day 0  — Email 1: Hook + value prop (3 sentences max)
Day 2  — Email 2: Social proof / case study angle
Day 5  — Email 3: Pain-point reframe
Day 9  — Email 4: Objection pre-emption
Day 14 — Email 5: Breakup ("last email, no hard feelings")

Reply at any point → remove from sequence, route to human
```

```python
# Email 1 template variables
EMAIL_1 = """
Subject: {first_name}, quick question about {company_pain_area}

Hi {first_name},

{personalised_opener_based_on_signal}.

{one_sentence_value_prop_tied_to_their_pain}.

Worth a 15-min call this week?

{signature}
"""

# Personalisation signals to inject
SIGNALS = ["recent blog post", "job posting", "funding news", "product launch", "competitor mention"]
```

## 4) Deliverability setup

```bash
# DNS records required per sending domain
# SPF
v=spf1 include:sendgrid.net include:amazonses.com ~all

# DKIM (via sending provider)
selector._domainkey.yourdomain.com → CNAME to provider

# DMARC
_dmarc.yourdomain.com TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com; pct=100"

# Warmup schedule (new domain/inbox)
Week 1:  10 emails/day
Week 2:  25 emails/day
Week 3:  50 emails/day
Week 4: 100 emails/day
Week 6: 200 emails/day (max for cold)

# Health targets
Open rate:    > 40%
Reply rate:   > 5%
Bounce rate:  < 2%
Spam rate:    < 0.1%
```

## 5) Apollo.io patterns

```python
# Lead enrichment via Apollo API
import httpx

async def enrich_lead(email: str) -> dict:
    res = await httpx.AsyncClient().post(
        "https://api.apollo.io/v1/people/match",
        json={"email": email, "reveal_personal_emails": False},
        headers={"X-Api-Key": APOLLO_API_KEY},
    )
    person = res.json().get("person", {})
    return {
        "name":       person.get("name"),
        "title":      person.get("title"),
        "company":    person.get("organization", {}).get("name"),
        "linkedin":   person.get("linkedin_url"),
        "employees":  person.get("organization", {}).get("num_employees"),
        "industry":   person.get("organization", {}).get("industry"),
    }

# Search for leads matching ICP
async def search_leads(icp: dict, limit: int = 100) -> list[dict]:
    res = await httpx.AsyncClient().post(
        "https://api.apollo.io/v1/mixed_people/search",
        json={
            "person_titles": icp["demographic"]["title"],
            "organization_num_employees_ranges": ["10,200"],
            "page": 1, "per_page": limit,
        },
        headers={"X-Api-Key": APOLLO_API_KEY},
    )
    return res.json().get("people", [])
```

## 6) CRM pipeline stages

```python
PIPELINE_STAGES = [
    {"stage": "prospect",    "definition": "identified, not yet contacted"},
    {"stage": "contacted",   "definition": "sequence started"},
    {"stage": "replied",     "definition": "responded (any reply)"},
    {"stage": "interested",  "definition": "expressed interest, booked call"},
    {"stage": "demo",        "definition": "call completed"},
    {"stage": "proposal",    "definition": "sent proposal or pricing"},
    {"stage": "closed_won",  "definition": "became customer"},
    {"stage": "closed_lost", "definition": "no-go, reason logged"},
]

# Velocity targets (days per stage transition)
VELOCITY = {
    "prospect→contacted":   1,
    "contacted→replied":    7,
    "replied→interested":   2,
    "interested→demo":      3,
    "demo→proposal":        2,
    "proposal→closed":      14,
}
```

## 7) Reply handling automation

```python
REPLY_CLASSIFIER_PROMPT = """
Classify this reply as one of:
- INTERESTED: wants to learn more or book a call
- NOT_NOW: open but wrong timing
- NOT_RIGHT_FIT: wrong company/role
- UNSUBSCRIBE: wants to be removed
- OUT_OF_OFFICE: auto-reply
- OTHER: anything else

Reply: {reply_text}
Output only the classification label.
"""

async def handle_reply(lead_id: str, reply_text: str):
    classification = await llm_call(
        prompt=REPLY_CLASSIFIER_PROMPT.format(reply_text=reply_text)
    )
    actions = {
        "INTERESTED":    lambda: schedule_followup(lead_id, priority="high"),
        "NOT_NOW":       lambda: snooze_lead(lead_id, days=30),
        "UNSUBSCRIBE":   lambda: unsubscribe(lead_id),
        "OUT_OF_OFFICE": lambda: pause_sequence(lead_id, days=5),
    }
    await actions.get(classification.strip(), lambda: log_reply(lead_id, classification))()
```

## 8) Outbound metrics dashboard

```python
OUTBOUND_METRICS = {
    "leads_sourced_week":    "# new leads added to pipeline",
    "sequences_active":      "# contacts currently in a sequence",
    "open_rate":             "target > 40%",
    "reply_rate":            "target > 5%",
    "positive_reply_rate":   "target > 2% (INTERESTED + NOT_NOW)",
    "meetings_booked_week":  "target: sequence_starts × 0.03",
    "pipeline_value":        "sum of deal values in active stages",
    "cac_outbound":          "spend / closed_won customers",
}
```

## 9) Checklist — before launching a sequence

- [ ] Domain warmed up (≥ 4 weeks) with open/reply rates healthy
- [ ] SPF, DKIM, DMARC all passing (use mail-tester.com)
- [ ] ICP defined with negative list included
- [ ] Lead list enriched and scored (only hot/warm get sequences)
- [ ] Email copy reviewed: ≤ 150 words per email, no spam trigger words
- [ ] Unsubscribe mechanism in place
- [ ] Reply routing configured (auto-classify → CRM update)
- [ ] Daily send limits set (stay within warmup schedule)
- [ ] A/B test on subject line (2 variants, min 100 sends each before deciding)
