export function getPublicAssetPath(fileName: string): string {
  return `${import.meta.env.BASE_URL}${fileName.replace(/^\/+/, "")}`;
}
