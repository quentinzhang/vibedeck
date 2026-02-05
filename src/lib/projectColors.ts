function hashString(value: string): number {
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getProjectAccentColor(projectName: string): string {
  const hue = hashString(projectName) % 360;
  return `hsl(${hue} 75% 60%)`;
}

export function getProjectAccentSoftColor(projectName: string): string {
  const hue = hashString(projectName) % 360;
  return `hsl(${hue} 75% 60% / 0.16)`;
}

