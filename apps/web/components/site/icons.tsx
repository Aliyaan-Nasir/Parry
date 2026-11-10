// Line icons for the site, drawn on a 20 unit grid with 1.5 strokes to match the hairline style.
import type { ReactNode, SVGProps } from "react";

function Icon({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PasskeyIcon = () => (
  <Icon>
    <circle cx="7" cy="7.5" r="3.5" />
    <path d="M9.6 9.9 L16.5 16.8 M13.6 13.9 L15.4 12.1 M15.4 15.7 L17 14.1" />
  </Icon>
);

export const SignatureIcon = () => (
  <Icon>
    <path d="M3 15.5 C 5 11.5, 6.5 11, 7.5 12.5 S 9.5 15.5, 11 13 S 13 9.5, 14.5 11.5" />
    <path d="M3 18 H17" />
    <path d="M13.5 3.5 L16.5 6.5 L11 12" />
  </Icon>
);

export const LanesIcon = () => (
  <Icon>
    <path d="M3 5.5 H17 M3 10 H17 M3 14.5 H17" />
    <circle cx="7" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="10" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="9.5" cy="14.5" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
);

export const ReviewIcon = () => (
  <Icon>
    <path d="M10 2.5 L16.5 5 V9.5 C 16.5 13.5, 13.8 16.3, 10 17.5 C 6.2 16.3, 3.5 13.5, 3.5 9.5 V5 Z" />
    <path d="M7.2 10 L9.2 12 L12.9 8.2" />
  </Icon>
);

export const ChipIcon = () => (
  <Icon>
    <rect x="5" y="5" width="10" height="10" rx="1.5" />
    <rect x="8" y="8" width="4" height="4" rx="0.5" />
    <path d="M8 2.5 V5 M12 2.5 V5 M8 15 V17.5 M12 15 V17.5 M2.5 8 H5 M2.5 12 H5 M15 8 H17.5 M15 12 H17.5" />
  </Icon>
);

export const ShieldRouteIcon = () => (
  <Icon>
    <path d="M3 14 C 6 14, 6 6, 10 6 S 14 14, 17 14" strokeDasharray="2 2.4" />
    <circle cx="3" cy="14" r="1.6" />
    <circle cx="17" cy="14" r="1.6" />
    <path d="M7.5 3 L12.5 3" />
  </Icon>
);

export const ReceiptIcon = () => (
  <Icon>
    <path d="M5 2.5 H15 V17.5 L12.5 16 L10 17.5 L7.5 16 L5 17.5 Z" />
    <path d="M8 7 H12 M8 10 H12 M8 13 H10.5" />
  </Icon>
);

export const PlugIcon = () => (
  <Icon>
    <path d="M7 2.5 V6 M13 2.5 V6" />
    <path d="M5 6 H15 V9 C 15 11.8, 12.8 14, 10 14 C 7.2 14, 5 11.8, 5 9 Z" />
    <path d="M10 14 V17.5" />
  </Icon>
);

export const StackIcon = () => (
  <Icon>
    <path d="M10 2.75 L17 6.25 L10 9.75 L3 6.25 Z" />
    <path d="M3 10 L10 13.5 L17 10" />
    <path d="M3 13.75 L10 17.25 L17 13.75" />
  </Icon>
);

export const RelayIcon = () => (
  <Icon>
    <path d="M3 6.5 H13.5 M10.5 3.5 L13.5 6.5 L10.5 9.5" />
    <path d="M17 13.5 H6.5 M9.5 10.5 L6.5 13.5 L9.5 16.5" />
  </Icon>
);

export const FileIcon = () => (
  <Icon>
    <path d="M5 2.75 H11.5 L15 6.25 V17.25 H5 Z" />
    <path d="M11.25 2.75 V6.5 H15 M7.75 10 H12.25 M7.75 13 H12.25" />
  </Icon>
);

export const SparkIcon = () => (
  <Icon>
    <path d="M10 2.75 V6 M10 14 V17.25 M2.75 10 H6 M14 10 H17.25 M4.9 4.9 L7.2 7.2 M12.8 12.8 L15.1 15.1 M4.9 15.1 L7.2 12.8 M12.8 7.2 L15.1 4.9" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="M4.5 10.5 L8.2 14 L15.5 6.5" />
  </Icon>
);

export const CrossIcon = () => (
  <Icon>
    <path d="M5.5 5.5 L14.5 14.5 M14.5 5.5 L5.5 14.5" />
  </Icon>
);

export const ArrowRightIcon = () => (
  <Icon>
    <path d="M4 10 H16 M11.5 5.5 L16 10 L11.5 14.5" />
  </Icon>
);

export const ArrowDownIcon = () => (
  <Icon>
    <path d="M10 4 V16 M5.5 11.5 L10 16 L14.5 11.5" />
  </Icon>
);

export const LockIcon = () => (
  <Icon>
    <rect x="4" y="8.5" width="12" height="9" rx="1.75" />
    <path d="M6.75 8.5 V6.25 C 6.75 4.45, 8.2 3, 10 3 C 11.8 3, 13.25 4.45, 13.25 6.25 V8.5" />
  </Icon>
);

export const EyeIcon = () => (
  <Icon>
    <path d="M2 10 C 4 6, 6.8 4.5, 10 4.5 S 16 6, 18 10 C 16 14, 13.2 15.5, 10 15.5 S 4 14, 2 10 Z" />
    <circle cx="10" cy="10" r="2.5" />
  </Icon>
);

export const GitHubIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor">
    <path d="M8 0.2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2Z" />
  </svg>
);

/** Two chains with a check between them: a transaction confirmed on another chain. */
export const VerifiedLinkIcon = () => (
  <Icon>
    <rect x="2.5" y="6" width="5.5" height="8" rx="1.5" />
    <rect x="12" y="6" width="5.5" height="8" rx="1.5" />
    <path d="M8 10 H12 M8.6 12.8 L9.8 14 L11.6 11.8" />
  </Icon>
);

/** A lattice: post-quantum (lattice-based) signatures. */
export const LatticeIcon = () => (
  <Icon>
    <path d="M4 4 L10 7 L16 4 M4 4 V10 L10 13 V7 M16 4 V10 L10 13 M4 10 L4 16 L10 19 V13 M16 10 V16 L10 19" />
  </Icon>
);

/** A storefront awning: a listing on a market. */
export const MarketIcon = () => (
  <Icon>
    <path d="M3 8 L4.5 3.5 H15.5 L17 8 Q17 10 14.8 10 Q12.6 10 12.6 8 Q12.6 10 10 10 Q7.4 10 7.4 8 Q7.4 10 5.2 10 Q3 10 3 8 Z" />
    <path d="M4.5 10 V16.5 H15.5 V10 M8.5 16.5 V12.5 H11.5 V16.5" />
  </Icon>
);

export const MenuIcon = () => (
  <Icon>
    <path d="M3 6 H17 M3 10 H17 M3 14 H17" />
  </Icon>
);
