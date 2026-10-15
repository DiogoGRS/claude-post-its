export type Subtask = {
  id: string
  text: string
  isDone: boolean
}

export type Note = {
  id: string
  text: string
  createdAt: number
  doneAt: number | null
  subtasks: Subtask[]
  // Nome da cor na paleta (laranja, azul, ...), gravado quando o post-it é criado.
  color: string
}

export type Tab = 'open' | 'done'

declare module 'claude-code' {
  interface PluginState {
    'post-its': {
      notes: Note[]
      tab: Tab
      addingSubtaskTo: string | null
      // `<noteId>:<subtaskId>` da subtarefa em edição, ou nenhuma.
      editingSubtask: string | null
    }
  }
}
