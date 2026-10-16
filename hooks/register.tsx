import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderViewport, Timer } from 'claude-code'

import type { Note, Subtask } from '../types'

const PANE = 'post-its'
const TITLE = 'Post-its'
// Cores dos post-its, na ordem em que são distribuídas: o post-it criado com o contador em n
// recebe a cor da posição n % 6. A cor fica gravada nele, então mudar a lista não repinta os antigos.
const PALETTE = {
  laranja: '#E07B53',
  azul: '#4A9EFF',
  amarelo: '#E5C07B',
  verde: '#5FB878',
  ciano: '#3CC8C8',
  roxo: '#A47DE8',
} as const
type ColorName = keyof typeof PALETTE
const COLOR_ORDER = Object.keys(PALETTE) as ColorName[]

const notes = atom({ plugin: 'post-its', key: 'notes' } as const, [])
const tab = atom({ plugin: 'post-its', key: 'tab' } as const, 'open')
// O post-it cujo campo de subtarefa está aberto, ou nenhum.
const addingSubtaskTo = atom({ plugin: 'post-its', key: 'addingSubtaskTo' } as const, null)
const editingSubtask = atom({ plugin: 'post-its', key: 'editingSubtask' } as const, null)

function isSubtask(value: unknown): value is Subtask {
  if (typeof value !== 'object' || value === null) return false
  const sub = value as Record<string, unknown>

  return typeof sub.id === 'string' && typeof sub.text === 'string' && typeof sub.isDone === 'boolean'
}

// Lê um post-it do store; os gravados antes das subtarefas existirem entram com a lista vazia.
function toNote(value: unknown): Note | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const note = value as Record<string, unknown>
  const isValid =
    typeof note.id === 'string' &&
    typeof note.text === 'string' &&
    typeof note.createdAt === 'number' &&
    (note.doneAt === null || typeof note.doneAt === 'number')
  if (!isValid) return undefined

  return {
    id: note.id as string,
    text: note.text as string,
    createdAt: note.createdAt as number,
    doneAt: note.doneAt as number | null,
    subtasks: Array.isArray(note.subtasks) ? note.subtasks.filter(isSubtask) : [],
    // Sem cor válida fica vazio: o session.start distribui as cores que faltam.
    color: isColorName(note.color) ? note.color : '',
  }
}

// O estado da sessão pode ainda ter post-its de antes das subtarefas (um reload desenha antes
// do session.start normalizar): quem lê a lista passa por aqui.
const withSubtasks = (note: Note): Note => ({ ...note, subtasks: note.subtasks ?? [] })

const newId = (now: number) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const pad = (n: number) => String(n).padStart(2, '0')

function formatDate(ms: number): string {
  const d = new Date(ms)

  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const isColorName = (value: unknown): value is ColorName =>
  typeof value === 'string' && Object.hasOwn(PALETTE, value)

const colorAt = (count: number): ColorName => COLOR_ORDER[count % COLOR_ORDER.length] ?? 'laranja'

const colorOf = (note: Note) => PALETTE[isColorName(note.color) ? note.color : 'laranja']

// Cada pasta tem o seu quadro: os post-its e o contador de cores ficam no store sob a pasta onde a
// sessão começou. Um /cd no meio da sessão não troca de quadro; a próxima sessão naquela pasta, sim.
let folder: string | undefined

async function boardKey($: EngineInterface, name: 'notes' | 'colorCounter') {
  folder ??= await $.session.root()

  return `${name}:${folder}`
}

// O contador só sobe (apagar um post-it não o faz voltar) e fica no store, entre sessões.
async function readColorCounter($: EngineInterface) {
  const stored = await $.store.get(await boardKey($, 'colorCounter'))

  return typeof stored === 'number' ? stored : 0
}

async function nextColor($: EngineInterface): Promise<ColorName> {
  const count = await readColorCounter($)
  await $.store.set(await boardKey($, 'colorCounter'), count + 1)

  return colorAt(count)
}

// Toda mudança passa por aqui: grava no estado da sessão (redesenha o painel)
// e no store do plugin (sobrevive entre sessões).
async function change($: EngineInterface, fn: (list: Note[]) => Note[]) {
  const saved = await update($, notes, list => fn(list.map(withSubtasks)))
  await $.store.set(await boardKey($, 'notes'), saved)
}

async function add($: EngineInterface, text: string) {
  const trimmed = text.trim()
  if (trimmed === '') return

  const now = await $.clock.now()
  const color = await nextColor($)
  await change($, list => [
    ...list,
    { id: newId(now), text: trimmed, createdAt: now, doneAt: null, subtasks: [], color },
  ])
}

// Abre (ou fecha, se já aberto) o campo de subtarefa do post-it e leva o foco até ele.
async function toggleSubtaskField($: EngineInterface, noteId: string) {
  const target = await update($, addingSubtaskTo, current => (current === noteId ? null : noteId))
  if (target === noteId) {
    await $.ui.focus({ requestId: PANE, key: `subtask:${noteId}` }).catch(() => undefined)
  }
}

// Enter com texto cria a subtarefa; Enter vazio só fecha o campo.
async function addSubtask($: EngineInterface, noteId: string, text: string) {
  const trimmed = text.trim()
  if (trimmed !== '') {
    const subtask = { id: newId(await $.clock.now()), text: trimmed, isDone: false }
    await change($, list =>
      list.map(note =>
        note.id === noteId ? { ...note, subtasks: [...note.subtasks, subtask] } : note,
      ),
    )
  }
  await update($, addingSubtaskTo, () => null)
}

const toggleSubtask = ($: EngineInterface, noteId: string, subtaskId: string) =>
  change($, list =>
    list.map(note =>
      note.id === noteId
        ? {
            ...note,
            subtasks: note.subtasks.map(sub =>
              sub.id === subtaskId ? { ...sub, isDone: !sub.isDone } : sub,
            ),
          }
        : note,
    ),
  )

// Abre (ou fecha, se já aberta) a edição da subtarefa e leva o foco até o campo.
async function toggleSubtaskEdit($: EngineInterface, noteId: string, subtaskId: string) {
  const key = `${noteId}:${subtaskId}`
  const target = await update($, editingSubtask, current => (current === key ? null : key))
  if (target === key) {
    await $.ui.focus({ requestId: PANE, key: `editsub:${key}` }).catch(() => undefined)
  }
}

// Enter com texto salva; Enter vazio cancela e deixa o texto como estava.
async function saveSubtask($: EngineInterface, noteId: string, subtaskId: string, text: string) {
  const trimmed = text.trim()
  if (trimmed !== '') {
    await change($, list =>
      list.map(note =>
        note.id === noteId
          ? {
              ...note,
              subtasks: note.subtasks.map(sub =>
                sub.id === subtaskId ? { ...sub, text: trimmed } : sub,
              ),
            }
          : note,
      ),
    )
  }
  await update($, editingSubtask, () => null)
}

const removeSubtask = ($: EngineInterface, noteId: string, subtaskId: string) =>
  change($, list =>
    list.map(note =>
      note.id === noteId
        ? { ...note, subtasks: note.subtasks.filter(sub => sub.id !== subtaskId) }
        : note,
    ),
  )

async function complete($: EngineInterface, id: string) {
  const now = await $.clock.now()
  await change($, list => list.map(note => (note.id === id ? { ...note, doneAt: now } : note)))
}

const reopen = ($: EngineInterface, id: string) =>
  change($, list => list.map(note => (note.id === id ? { ...note, doneAt: null } : note)))

const remove = ($: EngineInterface, id: string) =>
  change($, list => list.filter(note => note.id !== id))

// ── Lugar e largura do painel ─────────────────────────────────────────────────────────────
// Como o Claude Code se comporta (medido e lido no código dele, versão 2.1.292):
// - o painel só fica na lateral em tela cheia e com o terminal em 110 colunas ou mais; abaixo
//   disso ele desce para cima do prompt, e não há como forçar a lateral;
// - a largura da lateral é a salva no ~/.claude.json (`pluginPanes.dockColumns`, onde vai a
//   largura arrastada na borda), lida quando o Claude Code inicia; sem ela, 45% do terminal
//   (até 90 colunas). O mod não define largura: o pedido dele perde para a salva;
// - aberto sem a pessoa pedir (por timer), o painel espera escondido até o terminal ter 110
//   colunas, e então aparece na lateral.

const DOCK_MIN_COLUMNS = 110
// Espera o terminal parar de mudar de tamanho antes de esconder o painel, para não piscar.
const RESIZE_SETTLE_MS = 400

const isNarrow = (isFullscreen: boolean | undefined, terminal: number) =>
  isFullscreen === true && terminal < DOCK_MIN_COLUMNS

const openPane = ($: EngineInterface, focus?: true) =>
  $.ui.open({ id: PANE, title: TITLE, ...(focus ? { focus } : {}) })

// Fecha e abre sem a pessoa pedir: o painel sai de cima do prompt e espera escondido até o
// terminal alargar.
async function hidePane($: EngineInterface) {
  await $.ui.close({ id: PANE })

  return openPane($)
}

// Abre por timer, sem a pessoa pedir: com o terminal estreito, espera escondido até alargar.
function openWhenWide($: EngineInterface) {
  $.clock.after(0, () => void openPane($))
}

// Esconder-até-alargar deste carregamento do módulo: o timer que espera o redimensionamento
// parar, e a largura para a qual já escondeu, para não fechar e abrir sem fim.
let settleTimer: Timer | undefined
let hiddenFor: number | undefined

// Chamado a cada desenho do painel (o Claude Code redesenha quando o terminal muda de largura).
// Se o painel desceu para cima do prompt porque o terminal estreitou, esconde e espera alargar.
// Fora da tela cheia não há lateral, então ali ele fica onde está.
function keepDocked(
  $: EngineInterface,
  placement: 'dock' | 'inline',
  viewport: RenderViewport | undefined,
) {
  settleTimer?.cancel()
  if (placement === 'dock') hiddenFor = undefined
  if (placement !== 'inline' || viewport === undefined) return

  // Acima do prompt a conversa ocupa o terminal inteiro: a largura dela é a do terminal.
  const terminal = viewport.columns
  settleTimer = $.clock.after(RESIZE_SETTLE_MS, () => {
    if (!isNarrow(viewport.isFullscreen, terminal) || hiddenFor === terminal) return
    hiddenFor = terminal
    void hidePane($).catch(() => undefined)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    folder = await $.session.root()
    const saved = await $.store.get(await boardKey($, 'notes'))
    let list = Array.isArray(saved)
      ? saved.map(toNote).filter((note): note is Note => note !== undefined)
      : []

    // Post-its de antes das cores recebem as suas na ordem em que foram criados.
    const uncolored = list.filter(note => note.color === '').sort((a, b) => a.createdAt - b.createdAt)
    if (uncolored.length > 0) {
      let count = await readColorCounter($)
      const colors = new Map(uncolored.map(note => [note.id, colorAt(count++)]))
      list = list.map(note => ({ ...note, color: colors.get(note.id) ?? note.color }))
      await $.store.set(await boardKey($, 'colorCounter'), count)
      await $.store.set(await boardKey($, 'notes'), list)
    }

    await update($, notes, () => list)

    // Restos das versões anteriores: o dimensionamento e o quadro único, de antes de um por pasta.
    for (const key of [
      'widthColumns',
      'paneColumns',
      'widthDebug',
      'widthPct',
      'paneSize',
      'notes',
      'colorCounter',
    ]) {
      await $.store.delete(key)
    }

    await $.command.register({
      name: 'postits',
      description: 'Abre ou fecha o painel de post-its',
    })

    // Estava aberto na sessão anterior: reabre.
    if ((await $.store.get('isOpen')) === true) void openPane($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'postits' }, async ($, e) => {
    const terminal = e.presentation.columns
    const pane = (await $.ui.panes()).find(one => one.id === PANE)

    // Fecha se está à vista, ou se está esperando o terminal alargar.
    if (pane?.isShown === true || (pane !== undefined && !pane.isPlaced)) {
      await $.ui.close({ id: PANE })
      await $.store.set('isOpen', false)

      return { text: 'Post-its fechado.' }
    }

    await $.store.set('isOpen', true)

    if (isNarrow(e.presentation.isFullscreen, terminal)) {
      openWhenWide($)

      return {
        text: `O terminal tem ${terminal} colunas e o painel lateral precisa de ${DOCK_MIN_COLUMNS}: ele aparece sozinho quando o terminal alargar.`,
      }
    }

    await openPane($, true)

    return { text: 'Post-its aberto.' }
  })

  // Só o fechar da pessoa conta: o do próprio mod (esconder até alargar) mantém o painel ligado.
  on('ui.close', { id: 'post-its' }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.store.set('isOpen', false)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    keepDocked($, e.props.placement, e.viewport)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // O celular não desenha campo de texto.
    const Input = 'Input' in ui && e.surface !== 'mobile' ? ui.Input : undefined
    const list = (await read($, notes)).map(withSubtasks)
    const current = await read($, tab)
    const adding = await read($, addingSubtaskTo)
    const editing = await read($, editingSubtask)
    // Fundo do card de subtarefa: um tom acima do painel, claro ou escuro conforme o tema.
    const isLight = await $.config.list().then(
      rows => String(rows.find(row => row.key === 'theme')?.value ?? '').startsWith('light'),
      () => false,
    )
    const cardBackground = isLight ? '#e6e6e6' : '#333333'

    const open = list.filter(note => note.doneAt === null).reverse()
    const done = list
      .filter(note => note.doneAt !== null)
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))

    // Texto do post-it à esquerda, data no canto superior direito.
    const header = (text: string, date: string, isDim: boolean) => (
      <Box justifyContent="space-between" gap={2}>
        <Box flexShrink={1}>
          <Text dimColor={isDim}>{text}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{date}</Text>
        </Box>
      </Box>
    )

    // Ações no canto direito, separadas por uma barra para ficar claro onde um botão termina e o
    // outro começa, e uma linha em branco acima, para não colar no texto.
    const actions = (buttons: JSX.Element[]) => (
      <Box gap={1} flexWrap="wrap" justifyContent="flex-end" marginTop={1}>
        {buttons.flatMap((button, i) => (i === 0 ? [button] : [<Text dimColor>│</Text>, button]))}
      </Box>
    )

    // Título do painel: o terminal não muda o tamanho da fonte, então destaca com negrito e cor.
    const title = (
      <Text key="title" bold color="claude">
        Claude Post-its
      </Text>
    )

    const tabs = (
      <Box gap={1} flexWrap="wrap">
        <Button
          key="tab:open"
          label={`Abertos (${open.length})`}
          variant={current === 'open' ? 'primary' : 'secondary'}
          onPress={() => update($, tab, () => 'open')}
        />
        <Button
          key="tab:done"
          label={`Concluídos (${done.length})`}
          variant={current === 'done' ? 'primary' : 'secondary'}
          onPress={() => update($, tab, () => 'done')}
        />
      </Box>
    )

    if (current === 'done') {
      return (
        <Box flexDirection="column" gap={1}>
          {title}
          {tabs}
          {done.length === 0 && <Text dimColor>Nada concluído ainda.</Text>}
          {done.map(note => (
            <Box
              key={`note:${note.id}`}
              flexDirection="column"
              borderStyle="round"
              borderDimColor
              paddingX={2}
            >
              {header(note.text, `✓ ${formatDate(note.doneAt ?? note.createdAt)}`, true)}
              {note.subtasks.length > 0 && (
                <Box flexDirection="column" paddingLeft={4} gap={1}>
                  {note.subtasks.map(sub => (
                    <Box paddingX={1} backgroundColor={cardBackground}>
                      <Text dimColor>
                        {sub.isDone ? '[✓]' : '[ ]'} {sub.text}
                      </Text>
                    </Box>
                  ))}
                </Box>
              )}
              {actions([
                <Button
                  key={`reopen:${note.id}`}
                  plain
                  dimColor
                  label="↺ reabrir"
                  onPress={() => reopen($, note.id)}
                />,
                <Button
                  key={`remove:${note.id}`}
                  plain
                  dimColor
                  label="✕ apagar"
                  onPress={() => remove($, note.id)}
                />,
              ])}
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {title}
        {tabs}
        {Input ? (
          <Input
            key="new"
            placeholder="Novo post-it… (Enter cola)"
            submitLabel="colar"
            value=""
            autoFocus
            onSubmit={text => add($, text)}
          />
        ) : (
          <Text dimColor>Crie post-its pelo terminal ou pelo desktop.</Text>
        )}
        {open.length === 0 && <Text dimColor>Nenhum post-it aberto.</Text>}
        {open.map(note => (
          <Box
            key={`note:${note.id}`}
            flexDirection="column"
            borderStyle="round"
            borderColor={colorOf(note)}
            paddingX={2}
          >
            {header(note.text, formatDate(note.createdAt), false)}
            {(note.subtasks.length > 0 || adding === note.id) && (
              <Box flexDirection="column" paddingLeft={4} gap={1}>
                {note.subtasks.map(sub => {
                  const subKey = `${note.id}:${sub.id}`

                  return (
                    <Box
                      justifyContent="space-between"
                      gap={2}
                      paddingX={1}
                      backgroundColor={cardBackground}
                    >
                      {Input && editing === subKey ? (
                        <Box flexGrow={1}>
                          <Input
                            key={`editsub:${subKey}`}
                            value={sub.text}
                            placeholder="Vazio cancela"
                            submitLabel="salvar"
                            onSubmit={text => saveSubtask($, note.id, sub.id, text)}
                          />
                        </Box>
                      ) : (
                        <Box gap={1} flexShrink={1}>
                          <Button
                            key={`check:${subKey}`}
                            plain
                            dimColor={sub.isDone}
                            label={sub.isDone ? '[✓]' : '[ ]'}
                            onPress={() => toggleSubtask($, note.id, sub.id)}
                          />
                          <Text dimColor={sub.isDone} strikethrough={sub.isDone}>
                            {sub.text}
                          </Text>
                        </Box>
                      )}
                      <Box flexShrink={0} gap={1}>
                        {Input && (
                          <Button
                            key={`editbtn:${subKey}`}
                            plain
                            dimColor
                            label="(✎)"
                            onPress={() => toggleSubtaskEdit($, note.id, sub.id)}
                          />
                        )}
                        <Button
                          key={`rmsub:${subKey}`}
                          plain
                          dimColor
                          label="(✕)"
                          onPress={() => removeSubtask($, note.id, sub.id)}
                        />
                      </Box>
                    </Box>
                  )
                })}
                {Input && adding === note.id && (
                  <Box paddingX={1} backgroundColor={cardBackground}>
                    <Input
                      key={`subtask:${note.id}`}
                      placeholder="Subtarefa… (Enter cria, vazio cancela)"
                      submitLabel="criar"
                      value=""
                      onSubmit={text => addSubtask($, note.id, text)}
                    />
                  </Box>
                )}
              </Box>
            )}
            {actions([
              <Button
                key={`done:${note.id}`}
                plain
                label="✓ concluir"
                onPress={() => complete($, note.id)}
              />,
              ...(Input
                ? [
                    <Button
                      key={`addsub:${note.id}`}
                      plain
                      dimColor
                      label="+ subtarefa"
                      onPress={() => toggleSubtaskField($, note.id)}
                    />,
                  ]
                : []),
              <Button
                key={`remove:${note.id}`}
                plain
                dimColor
                label="✕ apagar"
                onPress={() => remove($, note.id)}
              />,
            ])}
          </Box>
        ))}
      </Box>
    )
  })
}
