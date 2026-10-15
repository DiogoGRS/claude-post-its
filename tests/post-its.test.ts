import type { On } from 'claude-code'
import type { RenderViewport } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

// Store em memória que o teste consegue ler (o mock.store do kit não expõe o conteúdo).
function memoryStore(on: On) {
  const saved = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...saved.keys()] }))

  return saved
}

const PANE = {
  title: 'Post-its',
  isFocused: true,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`cria, conclui, consulta e reabre um post-it (${surface})`, async ($, on) => {
    const saved = memoryStore(on)
    mock.clock(on, { now: Date.UTC(2026, 9, 15, 12, 0) })

    const ui = await $.ui.mount({
      plugin: 'post-its',
      surface,
      component: 'Pane',
      requestId: 'post-its',
      props: PANE,
    })

    expect(await ui.find({ text: /Nenhum post-it aberto/ })).toBeDefined()

    await ui.input({ key: 'new', text: '   ' })
    expect((await ui.find({ key: 'tab:open' }))?.text).toBe('Abertos (0)')

    await ui.input({ key: 'new', text: '  revisar PR do fiscal  ' })
    expect((await ui.find({ key: 'tab:open' }))?.text).toBe('Abertos (1)')
    expect(await ui.find({ type: 'Text', text: 'revisar PR do fiscal' })).toBeDefined()

    const stored = saved.get('notes')
    expect(stored).toMatchObject([{ text: 'revisar PR do fiscal', doneAt: null }])

    const doneButton = (await ui.findAll({ type: 'Button' })).find(one =>
      one.key?.startsWith('done:'),
    )
    expect(doneButton).toBeDefined()
    await ui.press({ key: doneButton?.key ?? '' })

    expect((await ui.find({ key: 'tab:open' }))?.text).toBe('Abertos (0)')
    expect((await ui.find({ key: 'tab:done' }))?.text).toBe('Concluídos (1)')
    expect(await ui.find({ type: 'Text', text: 'revisar PR do fiscal' })).toBeUndefined()

    await ui.press({ key: 'tab:done' })
    expect(await ui.find({ type: 'Text', text: 'revisar PR do fiscal' })).toBeDefined()
    expect(saved.get('notes')).toMatchObject([{ doneAt: Date.UTC(2026, 9, 15, 12, 0) }])

    const reopenButton = (await ui.findAll({ type: 'Button' })).find(one =>
      one.key?.startsWith('reopen:'),
    )
    await ui.press({ key: reopenButton?.key ?? '' })
    expect((await ui.find({ key: 'tab:open' }))?.text).toBe('Abertos (1)')
    expect(await ui.find({ text: /Nada concluído ainda/ })).toBeDefined()

    await ui.unmount()
  })
}

test('apaga um post-it e tira do store', async ($, on) => {
  const saved = memoryStore(on)
  mock.clock(on, { now: 0 })

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })

  await ui.input({ key: 'new', text: 'temporário' })
  const removeButton = (await ui.findAll({ type: 'Button' })).find(one =>
    one.key?.startsWith('remove:'),
  )
  await ui.press({ key: removeButton?.key ?? '' })

  expect((await ui.find({ key: 'tab:open' }))?.text).toBe('Abertos (0)')
  expect(saved.get('notes')).toEqual([])

  await ui.unmount()
})

test('no celular, sem campo de texto, ainda lista os post-its', async ($, on) => {
  memoryStore(on)
  mock.clock(on, { now: 0 })

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'mobile',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })

  expect(await ui.find({ text: /pelo terminal ou pelo desktop/ })).toBeDefined()
  expect(await ui.find({ key: 'tab:open' })).toBeDefined()

  await ui.unmount()
})

const RUN = { command: 'postits', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const buttonKey = async (ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]> }, prefix: string) =>
  (await ui.findAll({ type: 'Button' })).find(one => one.key?.startsWith(prefix))?.key ?? ''

for (const surface of ['terminal', 'desktop'] as const) {
  test(`subtarefa: abre o campo, Enter cria o checkbox, marcar conclui (${surface})`, async ($, on) => {
    const saved = memoryStore(on)
    mock.clock(on, { now: 0 })
    on('ui.focus', () => ({}))

    const ui = await $.ui.mount({
      plugin: 'post-its',
      surface,
      component: 'Pane',
      requestId: 'post-its',
      props: PANE,
    })

    await ui.input({ key: 'new', text: 'fechar PR do fiscal' })
    const noteId = (await buttonKey(ui, 'addsub:')).slice('addsub:'.length)
    expect(await ui.find({ key: `subtask:${noteId}` })).toBeUndefined()

    await ui.press({ key: `addsub:${noteId}` })
    expect(await ui.find({ key: `subtask:${noteId}` })).toBeDefined()

    await ui.input({ key: `subtask:${noteId}`, text: '  escrever o teste  ' })
    expect(await ui.find({ key: `subtask:${noteId}` })).toBeUndefined()
    const checkKey = await buttonKey(ui, `check:${noteId}:`)
    expect((await ui.find({ key: checkKey }))?.text).toBe('[ ]')
    expect(await ui.find({ type: 'Text', text: 'escrever o teste' })).toBeDefined()
    expect(saved.get('notes')).toMatchObject([
      { text: 'fechar PR do fiscal', subtasks: [{ text: 'escrever o teste', isDone: false }] },
    ])

    await ui.press({ key: checkKey })
    expect((await ui.find({ key: checkKey }))?.text).toBe('[✓]')
    expect(saved.get('notes')).toMatchObject([{ subtasks: [{ isDone: true }] }])

    await ui.press({ key: checkKey })
    expect((await ui.find({ key: checkKey }))?.text).toBe('[ ]')

    await ui.press({ key: `addsub:${noteId}` })
    await ui.input({ key: `subtask:${noteId}`, text: '   ' })
    expect(await ui.find({ key: `subtask:${noteId}` })).toBeUndefined()
    expect(saved.get('notes')).toMatchObject([{ subtasks: [{ text: 'escrever o teste' }] }])

    await ui.unmount()
  })
}

test('subtarefas aparecem só para leitura nos concluídos', async ($, on) => {
  memoryStore(on)
  mock.clock(on, { now: 0 })
  on('ui.focus', () => ({}))

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })

  await ui.input({ key: 'new', text: 'deploy' })
  const noteId = (await buttonKey(ui, 'addsub:')).slice('addsub:'.length)
  await ui.press({ key: `addsub:${noteId}` })
  await ui.input({ key: `subtask:${noteId}`, text: 'migrar índice' })
  await ui.press({ key: await buttonKey(ui, `check:${noteId}:`) })
  await ui.press({ key: `done:${noteId}` })
  await ui.press({ key: 'tab:done' })

  expect(await ui.find({ type: 'Text', text: /\[✓\] migrar índice/ })).toBeDefined()
  expect(await buttonKey(ui, 'check:')).toBe('')
  expect(await buttonKey(ui, 'addsub:')).toBe('')

  await ui.unmount()
})

test('post-its gravados antes das subtarefas carregam com a lista vazia', async ($, on) => {
  const saved = memoryStore(on)
  saved.set('notes', [
    { id: 'velho', text: 'post-it antigo', createdAt: 0, doneAt: null },
    { id: 'quebrado', text: 42 },
  ])
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })

  expect((await ui.find({ key: 'tab:open' }))?.text).toBe('Abertos (1)')
  expect(await ui.find({ key: 'addsub:velho' })).toBeDefined()

  await ui.unmount()
})

test('data no topo do cartão, ações separadas por barra e sem colar no prompt', async ($, on) => {
  memoryStore(on)
  mock.clock(on, { now: 0 })

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })

  await ui.input({ key: 'new', text: 'revisar' })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const noteAt = texts.indexOf('revisar')
  expect(texts[noteAt + 1]).toMatch(/^\d\d\/\d\d \d\d:\d\d$/)
  expect(texts.filter(text => text === '│')).toHaveLength(2)
  expect((await ui.findAll({ type: 'Button' })).map(one => one.text)).not.toContain('→ prompt')

  await ui.unmount()
})

test('✕ apaga só a subtarefa escolhida', async ($, on) => {
  const saved = memoryStore(on)
  mock.clock(on, { now: 0 })
  on('ui.focus', () => ({}))

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })

  await ui.input({ key: 'new', text: 'release' })
  const noteId = (await buttonKey(ui, 'addsub:')).slice('addsub:'.length)
  for (const text of ['gerar build', 'subir tag']) {
    await ui.press({ key: `addsub:${noteId}` })
    await ui.input({ key: `subtask:${noteId}`, text })
  }

  const removeKeys = (await ui.findAll({ type: 'Button' }))
    .map(one => one.key ?? '')
    .filter(key => key.startsWith(`rmsub:${noteId}:`))
  expect(removeKeys).toHaveLength(2)
  expect((await ui.find({ key: removeKeys[0] ?? '' }))?.text).toBe('(✕)')
  await ui.press({ key: removeKeys[0] ?? '' })

  expect(await ui.find({ type: 'Text', text: 'gerar build' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'subir tag' })).toBeDefined()
  expect(saved.get('notes')).toMatchObject([{ text: 'release', subtasks: [{ text: 'subir tag' }] }])

  await ui.unmount()
})

// Cria um post-it com uma subtarefa e devolve a chave `<noteId>:<subtaskId>` dela.
async function withSubtask(ui: Parameters<typeof buttonKey>[0] & {
  input: (t: { key: string; text: string }) => Promise<unknown>
  press: (t: { key: string }) => Promise<unknown>
}) {
  await ui.input({ key: 'new', text: 'release' })
  const noteId = (await buttonKey(ui, 'addsub:')).slice('addsub:'.length)
  await ui.press({ key: `addsub:${noteId}` })
  await ui.input({ key: `subtask:${noteId}`, text: 'gerar build' })

  return (await buttonKey(ui, `check:${noteId}:`)).slice('check:'.length)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`(✎) abre a edição da subtarefa e Enter salva (${surface})`, async ($, on) => {
    const saved = memoryStore(on)
    mock.clock(on, { now: 0 })
    on('ui.focus', () => ({}))

    const ui = await $.ui.mount({
      plugin: 'post-its',
      surface,
      component: 'Pane',
      requestId: 'post-its',
      props: PANE,
    })
    const subKey = await withSubtask(ui)

    expect((await ui.find({ key: `editbtn:${subKey}` }))?.text).toBe('(✎)')
    expect(await ui.find({ key: `editsub:${subKey}` })).toBeUndefined()
    await ui.press({ key: `editbtn:${subKey}` })

    const field = await ui.find({ key: `editsub:${subKey}` })
    expect(field?.props.value).toBe('gerar build')

    await ui.input({ key: `editsub:${subKey}`, text: '  gerar build de produção  ' })
    expect(await ui.find({ key: `editsub:${subKey}` })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'gerar build de produção' })).toBeDefined()
    expect(saved.get('notes')).toMatchObject([{ subtasks: [{ text: 'gerar build de produção' }] }])

    await ui.unmount()
  })
}

test('Enter vazio ou (✎) de novo cancela a edição e mantém o texto', async ($, on) => {
  const saved = memoryStore(on)
  mock.clock(on, { now: 0 })
  on('ui.focus', () => ({}))

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })
  const subKey = await withSubtask(ui)

  await ui.press({ key: `editbtn:${subKey}` })
  await ui.input({ key: `editsub:${subKey}`, text: '   ' })
  expect(await ui.find({ key: `editsub:${subKey}` })).toBeUndefined()

  await ui.press({ key: `editbtn:${subKey}` })
  await ui.press({ key: `editbtn:${subKey}` })
  expect(await ui.find({ key: `editsub:${subKey}` })).toBeUndefined()

  expect(await ui.find({ type: 'Text', text: 'gerar build' })).toBeDefined()
  expect(saved.get('notes')).toMatchObject([{ subtasks: [{ text: 'gerar build' }] }])

  await ui.unmount()
})

test('subtarefa feita continua riscada e editável', async ($, on) => {
  memoryStore(on)
  mock.clock(on, { now: 0 })
  on('ui.focus', () => ({}))

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })
  const subKey = await withSubtask(ui)

  await ui.press({ key: `check:${subKey}` })
  expect((await ui.find({ type: 'Text', text: 'gerar build' }))?.props.strikethrough).toBe(true)

  await ui.press({ key: `editbtn:${subKey}` })
  await ui.input({ key: `editsub:${subKey}`, text: 'gerar build final' })
  expect((await ui.find({ type: 'Text', text: 'gerar build final' }))?.props.strikethrough).toBe(true)

  await ui.unmount()
})

const HEX = {
  laranja: '#E07B53',
  azul: '#4A9EFF',
  amarelo: '#E5C07B',
  verde: '#5FB878',
  ciano: '#3CC8C8',
  roxo: '#A47DE8',
}

test('cores seguem o resto do contador: laranja, azul, amarelo, verde, ciano, roxo e recomeça', async ($, on) => {
  const saved = memoryStore(on)
  mock.clock(on, { now: 0 })

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })

  for (const n of [1, 2, 3, 4, 5, 6, 7]) await ui.input({ key: 'new', text: `post-it ${n}` })

  const stored = saved.get('notes') as { id: string; color: string }[]
  const expected = ['laranja', 'azul', 'amarelo', 'verde', 'ciano', 'roxo', 'laranja'] as const
  expect(stored.map(note => note.color)).toEqual([...expected])
  expect(saved.get('colorCounter')).toBe(7)

  for (const [i, note] of stored.entries()) {
    const card = await ui.find({ key: `note:${note.id}` })
    expect(card?.props.borderColor).toBe(HEX[expected[i] ?? 'laranja'])
  }

  await ui.unmount()
})

test('apagar um post-it não faz o contador voltar', async ($, on) => {
  const saved = memoryStore(on)
  mock.clock(on, { now: 0 })

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })

  await ui.input({ key: 'new', text: 'primeiro' })
  await ui.input({ key: 'new', text: 'segundo' })
  const second = (saved.get('notes') as { id: string }[])[1]
  await ui.press({ key: `remove:${second?.id}` })
  await ui.input({ key: 'new', text: 'terceiro' })

  expect((saved.get('notes') as { color: string }[]).map(note => note.color)).toEqual([
    'laranja',
    'amarelo',
  ])

  await ui.unmount()
})

test('post-its sem cor ganham cores pela ordem de criação e o contador continua', async ($, on) => {
  const saved = memoryStore(on)
  mock.clock(on, { now: 100 })
  saved.set('notes', [
    { id: 'novo', text: 'criado depois', createdAt: 50, doneAt: null, subtasks: [] },
    { id: 'velho', text: 'criado antes', createdAt: 10, doneAt: null, subtasks: [] },
    { id: 'pintado', text: 'já tinha cor', createdAt: 20, doneAt: null, subtasks: [], color: 'roxo' },
  ])
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(saved.get('notes')).toMatchObject([
    { id: 'novo', color: 'azul' },
    { id: 'velho', color: 'laranja' },
    { id: 'pintado', color: 'roxo' },
  ])
  expect(saved.get('colorCounter')).toBe(2)

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })
  await ui.input({ key: 'new', text: 'mais um' })
  expect((saved.get('notes') as { color: string }[]).at(-1)?.color).toBe('amarelo')

  await ui.unmount()
})

test('título em negrito acima das abas, nas duas abas', async ($, on) => {
  memoryStore(on)
  mock.clock(on, { now: 0 })

  const ui = await $.ui.mount({
    plugin: 'post-its',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'post-its',
    props: PANE,
  })

  for (const tabKey of ['tab:open', 'tab:done']) {
    await ui.press({ key: tabKey })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts[0]?.text).toBe('Claude Post-its')
    expect(texts[0]?.props.bold).toBe(true)
  }

  await ui.unmount()
})

const INLINE = { ...PANE, placement: 'inline' } as const
// Mais que o tempo que o mod espera o redimensionamento parar.
const SETTLE = 500

// Desenha o painel (corpo de 40 colunas) como o Claude Code o entrega.
const mountPane = ($: Engine, props: typeof PANE | typeof INLINE, viewport: RenderViewport) =>
  $.ui.mount({ plugin: 'post-its', surface: 'terminal', component: 'Pane', requestId: 'post-its', props, viewport })

// Na lateral, o Claude Code informa ao desenho só a largura da conversa: terminal − painel − 1.
const docked = (terminal: number): RenderViewport => ({ columns: terminal - 40 - 1, rows: 40, isFullscreen: true })

// Registra, em ordem, os fechar/abrir que o mod pede ao Claude Code, com a largura pedida.
function paneCalls(on: Parameters<typeof memoryStore>[0], panes: unknown[] = []) {
  const calls: string[] = []
  on('ui.close', ($, e) => {
    calls.push(`close:${e.id}`)

    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    calls.push(e.columns === undefined ? `open:${e.id}` : `open:${e.id}:${e.columns}`)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: panes as never }))

  return calls
}

test('estreitou em tela cheia: esconde o painel e reabre esperando o terminal alargar', async ($, on) => {
  const saved = memoryStore(on)
  saved.set('isOpen', true)
  const clock = mock.clock(on, { now: 0 })
  const calls = paneCalls(on)

  const ui = await mountPane($, INLINE, { columns: 100, rows: 40, isFullscreen: true })
  await clock.advance(SETTLE)

  expect(calls).toEqual(['close:post-its', 'open:post-its'])
  expect(saved.get('isOpen')).toBe(true)

  await ui.unmount()
})

for (const [label, viewport] of [
  ['fora da tela cheia', { columns: 100, rows: 40, isFullscreen: false }],
  ['em tela cheia com 110 colunas ou mais', { columns: 120, rows: 40, isFullscreen: true }],
] as const) {
  test(`acima do prompt ${label}: deixa o painel onde está`, async ($, on) => {
    memoryStore(on)
    const clock = mock.clock(on, { now: 0 })
    const calls = paneCalls(on)

    const ui = await mountPane($, INLINE, viewport)
    await clock.advance(SETTLE)
    expect(calls).toEqual([])

    await ui.unmount()
  })
}

test('/postits com o terminal estreito avisa e só abre quando alargar', async ($, on) => {
  const saved = memoryStore(on)
  const clock = mock.clock(on, { now: 0 })
  const calls = paneCalls(on)

  const answer = await $.command.run({
    ...RUN,
    args: '',
    presentation: { isFullscreen: true, columns: 100 },
  })
  expect(answer.text).toMatch(/100 colunas.*110/)
  expect(calls).toEqual([])
  expect(saved.get('isOpen')).toBe(true)

  await clock.advance(1)
  expect(calls).toEqual(['open:post-its'])
})

test('/postits com o painel esperando o terminal alargar fecha de vez', async ($, on) => {
  const saved = memoryStore(on)
  saved.set('isOpen', true)
  mock.clock(on, { now: 0 })
  const calls = paneCalls(on, [
    { id: 'post-its', title: 'Post-its', isShown: false, isFocused: false, isPlaced: false },
  ])

  const answer = await $.command.run({
    ...RUN,
    args: '',
    presentation: { isFullscreen: true, columns: 100 },
  })
  expect(answer.text).toBe('Post-its fechado.')
  expect(calls).toEqual(['close:post-its'])
  expect(saved.get('isOpen')).toBe(false)
})

test('estreitou, alargou e estreitou de novo: esconde de novo', async ($, on) => {
  memoryStore(on)
  const clock = mock.clock(on, { now: 0 })
  const calls = paneCalls(on)
  const narrow = { columns: 100, rows: 40, isFullscreen: true } as const

  for (const [props, viewport] of [
    [INLINE, narrow],
    [PANE, docked(160)],
    [INLINE, narrow],
  ] as const) {
    const ui = await mountPane($, props, viewport)
    await clock.advance(SETTLE)
    await ui.unmount()
  }

  expect(calls).toEqual(['close:post-its', 'open:post-its', 'close:post-its', 'open:post-its'])
})

test('na lateral o mod não pede largura: a do Claude Code vale', async ($, on) => {
  memoryStore(on)
  const clock = mock.clock(on, { now: 0 })
  const calls = paneCalls(on)

  const ui = await mountPane($, PANE, docked(150))
  await clock.advance(SETTLE)
  expect(calls).toEqual([])

  const answer = await $.command.run({ ...RUN, args: '', presentation: { isFullscreen: true, columns: 200 } })
  expect(answer.text).toBe('Post-its aberto.')
  expect(calls).toEqual(['open:post-its'])

  await ui.unmount()
})

test('numa sessão nova reabre o painel e limpa o que sobrou das versões antigas', async ($, on) => {
  const saved = memoryStore(on)
  for (const [key, value] of Object.entries({
    isOpen: true,
    widthPct: 25,
    paneSize: { body: 75, terminal: 200 },
    widthColumns: 59,
    paneColumns: 75,
    widthDebug: [],
  })) {
    saved.set(key, value)
  }
  // O session.start não espera o painel abrir: o teste espera o pedido chegar.
  let opened: (columns: number | undefined) => void = () => undefined
  const openedWith = new Promise<number | undefined>(resolve => {
    opened = resolve
  })
  on('ui.open', ($, e) => {
    opened(e.columns)

    return { value: { isPlaced: true } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(await openedWith).toBeUndefined()
  expect([...saved.keys()].sort()).toEqual(['isOpen'])
})
