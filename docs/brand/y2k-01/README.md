# Ticket Guy — Your guy in the inbox

Status: visual direction for review, not an approved rebrand or implemented website.

`concept-board.webp` shows a homepage, a quieter email signature, a palette and three subject-line advertisements. Generated with the built-in image tool using the existing brand overview as a reference. No live site or email templates were changed.

## Creative recommendation

Make email the recognizable entry point: compose windows, subject lines, reply arrows, paperclips and a prominent my@ticketguy.now. Preserve the existing lime ticket character. Nostalgia should explain the service immediately.

Headline: You've got a ticket guy.
Support: Send the link. Ask the question. Tell me what you're after.
CTA: Email your ticket guy.

## Production interpretation for Claude, after design approval

- Use existing SVG brand assets, not logos extracted from the generated board. Generated lettering and proportions are directional.
- Cream #F7F4EC, ink #142438, lime #D7F36B. Suggested additional colors: desktop gray #D0D5DB and link blue #2563EB. Verify contrast in the implementation.
- System sans-serif for body text; monospace for email metadata only. Use regular readable sans-serif in actual outgoing emails even though this mockup includes monospace email body text.
- Homepage compose window is a product demonstration with a clear email action. If fields are editable, preserve the user's entered subject and body when opening their email client. Provide a copy-address fallback.
- On mobile, stack headline and compose window. Keep the address and CTA visible without a faux desktop interface.
- Minimize/close controls are visual references, not a requirement; omit nonfunctional controls in production. Avoid boot screens, fake notifications, sound and forced animation.
- The actual email has ordinary text, useful links and a small signature. Its outer preview frame and metadata are presentation context, not an HTML wrapper to send to customers.
- Use one sign-off plus the compact signature without needlessly repeating Ticket Guy twice.
- Do not implement the generated Events navigation unless a useful destination exists. This concept does not change the decision against building a giant directory.
- No fabricated deals, price history, availability, response times or human-review claims. The requests on the board are illustrative.
- The generator added 'Simple to reach. Harder to beat.' Treat this as unapproved exploratory copy; prefer the established 'Your second opinion before you buy.'

## Campaign concepts

1. Subject: Two seats. One anniversary. Help. — personal concierge use case.
2. Subject: Is $150 a good price? — second-opinion use case.
3. Before you buy, forward it to your guy. — link-forwarding use case and recommended first campaign.

Next design decision: judge whether this amount of desktop nostalgia feels right. If accepted, develop the responsive homepage and email signature separately using real text and existing vector assets. Claude owns implementation.

## Implementation (preview only)

Local development only (`pnpm dev`); every other environment answers 404.

- `/preview/home` — homepage. `?state=live` or `?state=coming_soon` shows either launch state.
- `/preview/signature` — the proposed signature in an ordinary email, first reply and follow-up, at 640px and 360px.

Code: `src/components/preview/` and `src/app/preview/`. The live homepage (`src/components/public/Landing.tsx`) and live email (`src/lib/email/`) are unchanged.
