/** Serialized metadata sidecar shape (`<uuid>.meta.json`). */
export interface FileMetadataData {
  file_id: string;
  filename: string;
  ttl: number;
  created_at: number;
  views?: number;
  downloads?: number;
  last_viewed_at?: number | null;
  last_downloaded_at?: number | null;
  size_bytes?: number;
  folder_id?: string | null;
}

/** Public metadata dictionary returned by the REST API and MCP tools. */
export interface PublicFileMetadata {
  id: string;
  filename: string;
  url: string;
  view_url: string;
  is_image: boolean;
  expires_in: number;
  created_at: number;
  size_bytes: number;
  views: number;
  downloads: number;
  last_viewed_at: number | null;
  last_downloaded_at: number | null;
  folder_id: string | null;
}

/** Serialized folder sidecar shape (`<uuid>.folder.json`). */
export interface FolderMetadataData {
  folder_id: string;
  name: string;
  created_at: number;
}

/** Public folder dictionary returned by the REST API and MCP tools. */
export interface PublicFolder {
  id: string;
  name: string;
  created_at: number;
  file_count: number;
  total_size_bytes: number;
  download_url: string;
}

/** Paginated folder listing payload. */
export interface FolderListPage {
  items: PublicFolder[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

/** Paginated listing payload. */
export interface FileListPage {
  items: PublicFileMetadata[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  total_size_bytes: number;
  expiring_soon_count: number;
}

/** Result of a successful upload (REST multipart-ish raw body or MCP tool). */
export interface UploadResult {
  url: string;
  id: string;
  expires_in: number;
}
