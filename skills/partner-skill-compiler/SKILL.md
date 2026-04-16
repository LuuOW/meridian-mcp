---
name: partner-skill-compiler
description: Partner skill compiler authority — synthesize grounded public evidence into a reusable partner prompt, persona profile, and SKILL.md with worldview, operating style, audience, offers, voice anchors, and strict anti-hallucination constraints
---

# partner-skill-compiler

Use this when the goal is to turn a researched public corpus into a practical partner-style skill or prompt that feels like the person without pretending to be them.

## Goal

Compile public evidence into a partner agent that:

- sounds directionally like the person
- prioritizes similarly
- uses similar mental models and examples
- stays grounded and citation-aware

## Required Buckets

- `identity_summary`
- `worldview_signals`
- `operating_style_signals`
- `audience_signals`
- `offer_signals`
- `first_person_signals`
- `writing_behavior_signals`
- `partner_prompt`

## Source Priorities

Highest:
- bio/about pages
- self-authored newsletters and articles
- transcript-backed episodes

Medium:
- self-authored landing pages
- direct profile pages

Lowest:
- testimonials
- customer quotes
- widget/social embed content
- channel landing pages

## Compilation Rules

1. Separate identity from reputation:
   - identity = what the person says they are or claims directly
   - reputation = what others say about them

2. Separate worldview from offers:
   - worldview = what they believe, optimize for, or repeatedly emphasize
   - offers = products, newsletters, courses, services, podcasts

3. Separate voice from biography:
   - voice = sentence shape, framing style, common openings, practical tone
   - biography = roles, history, credentials

4. Prefer repeated patterns over one-off lines

5. Penalize:
   - testimonial language
   - review snippets
   - chrome artifacts
   - anonymous or low-confidence claims

## Partner Prompt Design

A good partner prompt should include:

- what role the agent is simulating
- what kinds of recommendations it should bias toward
- what it should avoid
- what evidence buckets it should trust most
- an explicit boundary against private-memory fabrication

## Output Rule

The final skill should frame the result as:

- an evidence-backed partner simulation
- not identity verification
- not permission to impersonate the person in high-stakes contexts

## Validation Questions

- Does the prompt sound grounded in real source material?
- Are the best first-person lines self-authored rather than testimonial?
- Do worldview and operating-style sections reflect repeated evidence?
- Would a user get practical strategy from the skill, not just biography?
