export interface FileSearchMatch {
  relativePath: string
  absolutePath: string
  fileName: string
  kind: "file" | "directory"
  score: number
  indices: number[]
}

export type FileSearchRequest =
  | {
      type: "create-session"
      sessionId: string
      workspaceRoot: string
      resultLimit?: number
    }
  | {
      type: "update-query"
      sessionId: string
      query: string
    }
  | {
      type: "dispose-session"
      sessionId: string
    }

export type FileSearchEvent =
  | {
      type: "update"
      sessionId: string
      query: string
      matches: FileSearchMatch[]
      walkComplete: boolean
    }
  | {
      type: "complete"
      sessionId: string
      query: string
    }
  | {
      type: "error"
      sessionId: string
      query: string
      message: string
    }

export const FILE_SEARCH_RESULT_LIMIT = 20
export const FILE_SEARCH_VISIBLE_ROWS = 8
