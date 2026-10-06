// Decorative icons share one optical size; adjacent text supplies accessible names.
const paths = {
 home: '<path d="m3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9"/>',
 photos: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
 records: '<path d="M6 3h10a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM6 3v14M3 18a2 2 0 0 1 2-2h13M9 7h6M9 11h6"/>',
 settings: '<path d="M4 7h7m5 0h4M4 17h2m5 0h9"/><circle cx="13.5" cy="7" r="2.5"/><circle cx="8.5" cy="17" r="2.5"/>',
 sync: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
 check: '<path d="m5 12 4 4L19 6"/>',
 alert: '<path d="M12 6v7M12 17h.01"/>',
 external: '<path d="M14 3h7v7m0-7L11 13M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
} as const;
export type IconName = keyof typeof paths;
export function icon(name: IconName): string {
 return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}
