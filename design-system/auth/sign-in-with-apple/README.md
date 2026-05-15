# Sign in with Apple — official brand assets

Apple's official Sign in with Apple (SIWA) button assets, downloaded from
Apple's developer portal:
<https://developer.apple.com/design/resources/#sign-in-with-apple>

These are **trademarked Apple assets** — usage is governed by the Sign
in with Apple Human Interface Guidelines:
<https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple>

## What's here

Only the SVG versions ship in the repo (the PDF + PNG/@1x/2x/3x variants
from Apple's download remain in the original archive — added on demand if
we ever target native macOS/iOS).

```
left-aligned/    # logo + "Sign in with Apple" wordmark, left-aligned
  Logo - SIWA - Left-aligned - Black  - {Small,Medium,Large}.svg
  Logo - SIWA - Left-aligned - White  - {Small,Medium,Large}.svg

logo-only/       # the apple-with-wedge mark, no wordmark
  Logo - SIWA - Logo-only - {Black,White}.svg
```

## Hard rules from Apple's guidelines (read before using)

1. **Do not modify** the logos. No recolouring, no stroke changes, no
   masking, no adding effects. The black / white variants Apple ships are
   the *only* permitted colours.
2. **Use the correct variant for your background.** Black on light, white
   on dark. Avoid placing on busy / low-contrast backgrounds.
3. **Use the matching wordmark.** If the OS / browser locale is non-English,
   use the localised wordmark from Apple's download (not shipped here yet —
   add the language pack when we localise).
4. **Respect minimum sizing.** Per Apple's HIG: minimum tap target 44×44 pt.
   The "Small" variants are intended for ≥ 24 pt height contexts.
5. **Don't use SIWA marks in any context other than a Sign in with Apple
   button.** They aren't generic Apple branding.

## Usage in this repo

When wired up, embed via `<img>` (or inline if you want CSS theming), e.g.:

```html
<button class="siwa-btn" type="button">
  <img src="/design-system/auth/sign-in-with-apple/left-aligned/Logo - SIWA - Left-aligned - White - Medium.svg"
       alt="Sign in with Apple" height="44">
</button>
```

Native iOS/macOS apps should use `ASAuthorizationAppleIDButton` instead —
it picks the right asset and handles dark-mode / locale automatically.
These SVGs are for **web** contexts where that API isn't available.
