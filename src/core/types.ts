export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';

export interface IssueNode {
  target: string[];
  html: string;
  failureSummary?: string;
}

export interface Issue {
  source: 'axe' | 'keyboard' | 'custom';
  ruleId: string;
  impact: Impact;
  description: string;
  help: string;
  helpUrl?: string;
  tags: string[];
  nodes: IssueNode[];
}

export interface KeyboardStep {
  index: number;
  focusId: string | null;
  selector: string;
  tag: string;
  text: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
  focusVisible: boolean;
  tabIndex: number;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export interface KeyboardFinding {
  ruleId: string;
  impact: Impact;
  description: string;
  help: string;
  helpUrl?: string;
  selectors: string[];
}

export interface KeyboardProbeResult {
  maxTabs: number;
  steps: KeyboardStep[];
  findings: KeyboardFinding[];
  positiveTabindex: string[];
  unreachedInteractive: string[];
  focusTrap: boolean;
  focusLost: boolean;
}

export interface PageScanResult {
  url: string;
  finalUrl: string;
  status: number | null;
  title: string;
  metaRobots: string | null;
  headers: Record<string, string>;
  issues: Issue[];
  keyboard: KeyboardProbeResult;
  scores: {
    ada: number;
    keyboard: number;
    overall: number;
  };
  artifacts: {
    screenshot?: string;
    dom?: string;
    axe?: string;
    keyboard?: string;
  };
  timings: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  error?: string;
}

export interface RunManifest {
  schemaVersion: 1;
  id: string;
  toolVersion: string;
  targetUrl: string;
  config: unknown;
  page: PageScanResult;
  summary: {
    adaScore: number;
    keyboardScore: number;
    overallScore: number;
    issueCounts: Record<Impact, number>;
    keyboardFindings: number;
  };
}

export interface CrawlEdge {
  from: string;
  to: string;
  external: boolean;
}

export interface CrawledPage {
  url: string;
  finalUrl: string;
  status: number | null;
  title: string;
  metaRobots: string | null;
  depth: number;
  contentType: string;
  headers: Record<string, string>;
  links: string[];
  externalLinks: string[];
  audited: boolean;
  issues: Issue[];
  keyboardFindings: number;
  scores: {
    ada: number;
    keyboard: number;
    overall: number;
  };
  issueCounts: Record<Impact, number>;
  artifacts: PageScanResult['artifacts'];
  timings: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  error?: string;
}

export interface SiteTreeNode {
  name: string;
  path: string;
  url?: string;
  title?: string;
  status?: number | null;
  score?: number;
  children: SiteTreeNode[];
}

export interface SiteGraphNode {
  id: string;
  label: string;
  title: string;
  depth: number;
  status: number | null;
  score: number | null;
  audited: boolean;
  external: boolean;
}

export interface SiteGraphEdge {
  from: string;
  to: string;
}

export interface SiteGraph {
  nodes: SiteGraphNode[];
  edges: SiteGraphEdge[];
}

export interface CrawlStats {
  pages: number;
  audited: number;
  edges: number;
  externalLinks: number;
  blockedByRobots: number;
  errors: number;
  maxDepthReached: number;
}

export interface CrawlManifest {
  schemaVersion: 1;
  id: string;
  toolVersion: string;
  rootUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: unknown;
  stats: CrawlStats;
  summary: {
    adaScore: number;
    keyboardScore: number;
    overallScore: number;
    issueCounts: Record<Impact, number>;
    keyboardFindings: number;
  };
  pages: CrawledPage[];
  edges: CrawlEdge[];
  tree: SiteTreeNode;
  graph: SiteGraph;
  notices: string[];
}

export type IgnoreCategory = 'ada' | 'keyboard' | 'all';

export interface IgnoreRule {
  id: number;
  pattern: string;
  category: IgnoreCategory;
  reason: string;
  createdAt: string;
}
