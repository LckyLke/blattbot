const paths = {
  back: "m14 6-6 6 6 6",
  chevron: "m8 5 7 7-7 7",
  folder: "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
  file: "M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6",
  branch: "M6 7v10m12-10v3a3 3 0 0 1-3 3h-6a3 3 0 0 0-3 3M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  settings: "M4 7h9m4 0h3M4 17h3m4 0h9M15 4v6M9 14v6",
  sync: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
} as const;

export default function SidebarIcon({ name, className = "" }: { name: keyof typeof paths; className?: string }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
    <path d={paths[name]} />
  </svg>;
}
