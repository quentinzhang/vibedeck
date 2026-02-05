export type PrdStatus =
  | 'drafts'
  | 'pending'
  | 'in-progress'
  | 'in-review'
  | 'blocked'
  | 'done'
  | 'archived';

export type PrdType = 'bug' | 'feature' | 'improvement';

export type PrdPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type PrdSeverity = 'S0' | 'S1' | 'S2' | 'S3';

export interface HubCard {
  project: string;
  id: string;
  title: string;
  type: PrdType | null;
  status: PrdStatus;
  priority: PrdPriority | null;
  severity: PrdSeverity | null;
  component: string | null;
  updated_at: string | null;
  created_at: string | null;
  due_at: string | null;
  relPath: string;
}

export interface HubWarning {
  type: 'status_mismatch';
  relPath: string;
  frontmatterStatus: string;
  folderStatus: string;
}

export interface ProjectSummary {
  name: string;
  repo_path: string | null;
  counts: Record<string, number>;
  warnings: HubWarning[];
}

export interface HubStatusData {
  generated_at: string;
  projects: ProjectSummary[];
  cards: HubCard[];
}

