import type {
  AgentPersona,
  PersonaDraft,
  PersonaRevision,
  PromptTrial,
  VariantSearch,
} from '@loom/api-contract'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PersonaEditor from './PersonaEditor.vue'

/**
 * The persona form and its raw-markdown toggle.
 *
 * What these assert is the part a `client-core` test cannot: that the *component*
 * reads the pure functions correctly — that a planner's Bash checkbox is actually
 * disabled, that a save sends the tab the human was looking at, and that switching
 * tabs goes through the server's parser rather than a guess.
 */

const persona = (overrides: Partial<AgentPersona> = {}): AgentPersona => ({
  id: 'p1',
  workspaceId: 'w1',
  name: 'swe',
  description: 'Writes code',
  markdownSource: '---\nname: swe\ndescription: Writes code\nmodel: m\ntools: [Read]\n---\n\nBody.',
  model: 'claude-haiku-4-5-20251001',
  tools: ['Read'],
  harnessEffort: null,
  harnessMaxTurns: null,
  harnessApprovalMode: 'ask' as const,
  harnessPlanner: false,
  harnessDelegates: [],
  harnessBudgetCapUsd: null,
  envelope: null,
  builtinStatus: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
})

const draft = (overrides: Partial<PersonaDraft> = {}): PersonaDraft => ({
  ok: true,
  problems: [],
  parsed: {
    name: 'parsed-name',
    description: 'from the server',
    model: 'claude-sonnet-5',
    tools: ['Read', 'Bash'],
    systemPrompt: 'Parsed body.',
    envelope: null,
    harnessEffort: null,
    harnessMaxTurns: null,
    harnessApprovalMode: 'ask' as const,
    harnessPlanner: false,
    harnessDelegates: [],
    harnessBudgetCapUsd: null,
  },
  ...overrides,
})

const editor = (
  personas: AgentPersona[] = [persona()],
  revisions: PersonaRevision[] = [],
) =>
  mount(PersonaEditor, { props: { personas, capabilities: [], attachments: [], revisions } })

const revision = (over: Partial<PersonaRevision> = {}): PersonaRevision => ({
  id: 'r1',
  personaId: 'p1',
  markdownSource: '---\nname: swe\n---\n\nThe prompt it had before.',
  replacedByKind: 'agent_run',
  replacedByRunId: 'run-1',
  rationale: 'The tests are the definition of done here.',
  createdAt: '2026-08-16T10:00:00.000Z',
  ...over,
})

const openNew = async (wrapper: ReturnType<typeof editor>) => {
  await wrapper.get('.add').trigger('click')
  return wrapper
}

const fill = async (wrapper: ReturnType<typeof editor>) => {
  const inputs = wrapper.findAll('input[type="text"]')
  await inputs[0]?.setValue('new-persona')
  await inputs[1]?.setValue('Does a thing')
  await wrapper.get('textarea').setValue('You do a thing.')
}

describe('PersonaEditor', () => {
  it('opens on the form, not on raw markdown', async () => {
    const wrapper = await openNew(editor())
    expect(wrapper.find('textarea[aria-label="Persona markdown"]').exists()).toBe(false)
    expect(wrapper.findAll('input[type="text"]').length).toBeGreaterThan(0)
  })

  it('will not save an incomplete persona, and says what is missing', async () => {
    const wrapper = await openNew(editor())
    const submit = wrapper.get('button[type="submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    expect(wrapper.get('.problems').text()).toContain('name')
  })

  it('writes markdown from the form fields', async () => {
    const wrapper = await openNew(editor())
    await fill(wrapper)
    await wrapper.get('form').trigger('submit')

    const emitted = wrapper.emitted('create-persona')
    expect(emitted).toHaveLength(1)
    const markdown = emitted?.[0]?.[0] as string
    expect(markdown).toContain('name: new-persona')
    expect(markdown).toContain('tools: [Read, Grep, Glob]')
    expect(markdown.endsWith('You do a thing.')).toBe(true)
  })

  /**
   * The rule that makes the planner boundary visible where it is set rather than in a
   * server error after the fact. Three separate correct refusals currently combine to make
   * a shipped persona undelegatable, and the roadmap names showing that at design time as
   * this surface's highest-value job.
   */
  it('disables every acting tool once a persona is marked a planner', async () => {
    const wrapper = await openNew(editor())
    await fill(wrapper)
    const plannerBox = wrapper.findAll('input[type="checkbox"]').find((box) => {
      const parent = box.element.closest('label')
      return parent?.textContent?.includes('Planner') ?? false
    })
    await plannerBox?.setValue(true)

    const bash = wrapper
      .findAll('.chips .chip')
      .find((chip) => chip.text().startsWith('Bash'))
    expect(bash?.find('input').attributes('disabled')).toBeDefined()
  })

  it('offers the delegation envelope only on a planner', async () => {
    const wrapper = await openNew(editor())
    expect(wrapper.text()).not.toContain('Delegation envelope')
  })

  it('will not let a persona be renamed, because a name is its address', async () => {
    const wrapper = editor()
    await wrapper.get('.link').trigger('click')
    const name = wrapper.findAll('input[type="text"]')[0]
    expect(name?.attributes('disabled')).toBeDefined()
  })

  describe('the raw-markdown toggle', () => {
    it('shows the form serialized, and sends that text on save', async () => {
      const wrapper = await openNew(editor())
      await fill(wrapper)
      await wrapper.findAll('[role="tab"]')[1]?.trigger('click')

      const raw = wrapper.get('textarea[aria-label="Persona markdown"]')
      expect((raw.element as HTMLTextAreaElement).value).toContain('name: new-persona')

      await raw.setValue('---\nname: hand-written\ndescription: d\nmodel: m\n---\n\nBody.')
      await wrapper.get('form').trigger('submit')
      expect(wrapper.emitted('create-persona')?.[0]?.[0]).toContain('hand-written')
    })

    /**
     * Coming back from raw text is a parse, and the client does not own one — so it
     * asks the server. The fields that appear must be the server's reading, not a
     * second one, or the form shows settings a save would not store.
     */
    it('repopulates the form from the server parse, never from its own', async () => {
      const wrapper = await openNew(editor())
      await fill(wrapper)
      await wrapper.findAll('[role="tab"]')[1]?.trigger('click')
      await wrapper.findAll('[role="tab"]')[0]?.trigger('click')

      const parse = wrapper.emitted('parse')
      expect(parse).toHaveLength(1)
      const done = parse?.[0]?.[1] as (d: PersonaDraft) => void
      done(draft())
      await wrapper.vm.$nextTick()

      const inputs = wrapper.findAll('input[type="text"]')
      expect((inputs[0]?.element as HTMLInputElement).value).toBe('parsed-name')
      expect((inputs[1]?.element as HTMLInputElement).value).toBe('from the server')
    })

    it('stays on the raw tab when the draft does not parse, and shows why', async () => {
      const wrapper = await openNew(editor())
      await fill(wrapper)
      await wrapper.findAll('[role="tab"]')[1]?.trigger('click')
      await wrapper.findAll('[role="tab"]')[0]?.trigger('click')

      const done = wrapper.emitted('parse')?.[0]?.[1] as (d: PersonaDraft) => void
      done({ ok: false, problems: ['frontmatter is not closed'], parsed: null })
      await wrapper.vm.$nextTick()

      expect(wrapper.find('textarea[aria-label="Persona markdown"]').exists()).toBe(true)
      expect(wrapper.get('.problems').text()).toContain('not closed')
    })
  })

  /**
   * The guard on the one direction the client duplicates. If the markdown this form
   * wrote parses into something else, the human is looking at a persona they did not
   * author — and the honest thing is to say so, not to re-render the server's answer.
   */
  it('reports a save that stored something other than what was asked for', async () => {
    const wrapper = await openNew(editor([]))
    await fill(wrapper)
    await wrapper.get('form').trigger('submit')

    await wrapper.setProps({
      personas: [persona({ name: 'new-persona', tools: ['Read', 'Bash'] })],
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.get('.discrepancy').text()).toContain('tools')
  })

  it('says nothing when the save matches', async () => {
    const wrapper = await openNew(editor([]))
    await fill(wrapper)
    await wrapper.get('form').trigger('submit')

    await wrapper.setProps({
      personas: [
        persona({
          name: 'new-persona',
          description: 'Does a thing',
          tools: ['Read', 'Grep', 'Glob'],
        }),
      ],
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.discrepancy').exists()).toBe(false)
  })
})

/**
 * Continuity mode tier 1 — an agent rewriting its own prompt, from the side a human sees
 * it.
 *
 * The component half is where "correct and invisible" lives: the mechanism can be right
 * in every test below the UI and still ship a self-edit nobody notices and cannot undo.
 */
describe('self-edit history', () => {
  it('says on the row when an agent wrote the prompt a persona is running with', () => {
    const wrapper = editor([persona()], [revision()])
    expect(wrapper.text()).toContain('prompt rewritten by an agent')
  })

  it('says nothing when the last word was a human"s', () => {
    const wrapper = editor(
      [persona()],
      [
        revision({ id: 'r1', replacedByKind: 'agent_run', createdAt: '2026-08-16T10:00:00.000Z' }),
        revision({ id: 'r2', replacedByKind: 'human', createdAt: '2026-08-16T12:00:00.000Z' }),
      ],
    )
    expect(wrapper.text()).not.toContain('prompt rewritten by an agent')
  })

  it('shows the superseded prompt and its reason when the persona is opened', async () => {
    const wrapper = editor([persona()], [revision()])
    await wrapper.get('.row-actions .link').trigger('click')
    expect(wrapper.text()).toContain('The prompt it had before.')
    expect(wrapper.text()).toContain('The tests are the definition of done here.')
    expect(wrapper.text()).toContain('Replaced by an agent')
  })

  /**
   * The gesture that makes an agent editing itself without asking an acceptable trade —
   * asserted as an emitted event with its payload, because an unwired emit passes every
   * static check this repository has.
   */
  it('emits a revert naming the persona and the revision', async () => {
    const wrapper = editor([persona()], [revision()])
    await wrapper.get('.row-actions .link').trigger('click')
    const restore = wrapper
      .findAll('.history button')
      .find((button) => button.text() === 'Restore')
    expect(restore).toBeDefined()
    await restore!.trigger('click')
    // ConfirmButton asks first; the second press is the confirmation.
    await wrapper
      .findAll('.history button')
      .find((button) => button.text().includes('Put this prompt back'))!
      .trigger('click')
    expect(wrapper.emitted('revert-persona')).toEqual([[{ personaId: 'p1', revisionId: 'r1' }]])
  })

  it('offers no history for a persona nothing has replaced', async () => {
    const wrapper = editor()
    await wrapper.get('.row-actions .link').trigger('click')
    expect(wrapper.find('.history').exists()).toBe(false)
  })
})

/**
 * The trial panel, and specifically the definition of done inside it.
 *
 * Asserted on the mounted component because the field crosses a prop chain and a template,
 * and this repository has shipped six defects in surfaces whose unit tests and typecheck
 * were both clean. A number the server computes and the page never renders is the shape of
 * all six.
 */
describe('the prompt trial panel', () => {
  const trial = (over: Partial<PromptTrial['arms'][number]> = {}): PromptTrial => ({
    revisionId: 'r1',
    verdict: 'undecided',
    detail: 'Still measuring: 2 finished run(s) on the new prompt against 1.',
    arms: [
      {
        arm: 'revised',
        decided: 2,
        merged: 0,
        failed: 0,
        verificationFailed: 2,
        failingCheck: 'build',
        meanCostUsd: 0.1,
        ...over,
      },
      {
        arm: 'previous',
        decided: 1,
        merged: 1,
        failed: 0,
        verificationFailed: 0,
        failingCheck: null,
        meanCostUsd: 0.1,
      },
    ],
  })

  const opened = async (promptTrial: PromptTrial) => {
    const wrapper = mount(PersonaEditor, {
      props: {
        personas: [persona()],
        capabilities: [],
        attachments: [],
        revisions: [revision()],
        trials: { p1: promptTrial },
      },
    })
    await wrapper.get('.row-actions .link').trigger('click')
    return wrapper
  }

  it('names the check that failed most on the arm that produced it', async () => {
    const wrapper = await opened(trial())
    const arms = wrapper.findAll('.trial .arms li').map((li) => li.text())
    expect(arms[0]).toContain('2 failed checks')
    expect(arms[0]).toContain('mostly build')
    // Zero on the other side is printed, not omitted: a blank where a number belongs
    // reads as a pass, which is the same argument `not_run` is a recorded status for.
    expect(arms[1]).toContain('0 failed checks')
  })

  it('says nothing about checks when neither arm has failed one', async () => {
    const wrapper = await opened(trial({ verificationFailed: 0, failingCheck: null }))
    expect(wrapper.get('.trial').text()).not.toContain('failed checks')
  })
})

/**
 * The variant search panel.
 *
 * Two claims worth asserting on the mounted component. A human promoting a candidate is
 * agreeing to a document an agent wrote, so the panel has to *show* that document — a score
 * with no text asks somebody to approve what they cannot read. And both gestures that end a
 * search emit the same event with the same payload shape, which is the sort of thing an
 * unwired emit passes every static check while doing nothing.
 */
describe('the variant search panel', () => {
  const search = (over: Partial<VariantSearch> = {}): VariantSearch => ({
    personaId: 'p1',
    setId: 's1',
    detail: 'One candidate is ahead.',
    leader: 'v2',
    verifier: null,
    screen: null,
    /** Null is the older path: a run of this persona wrote these about its own work. */
    proposer: null,
    candidates: [
      { variantId: 'v1', body: 'READ THE TESTS FIRST.', rationale: 'tests before code' },
      { variantId: 'v2', body: 'WRITE THE SMALLEST DIFF.', rationale: 'small diffs land' },
    ],
    arms: [
      {
        variantId: null,
        decided: 5,
        merged: 2,
        failed: 0,
        verificationFailed: 0,
        failingCheck: null,
        meanCostUsd: 0.1,
        standing: 'undecided',
      },
      {
        variantId: 'v1',
        decided: 5,
        merged: 1,
        failed: 0,
        verificationFailed: 3,
        failingCheck: 'build',
        meanCostUsd: 0.1,
        standing: 'worse',
      },
      {
        variantId: 'v2',
        decided: 5,
        merged: 5,
        failed: 0,
        verificationFailed: 0,
        failingCheck: null,
        meanCostUsd: 0.1,
        standing: 'better',
      },
    ],
    ...over,
  })

  /**
   * The gesture that starts one. Mounted with no search and no trial, which is the only state
   * it is offered in: two measurements at once split the same runs across more arms than a
   * workspace can fill, so a button that is always there and usually refused would teach a
   * human to ignore it.
   */
  const openedIdle = async (
    startProposer: (input: { personaId: string }) => Promise<{
      started: boolean
      reason: string | null
    }>,
  ) => {
    const wrapper = mount(PersonaEditor, {
      props: {
        personas: [persona()],
        capabilities: [],
        attachments: [],
        revisions: [],
        startProposer,
      },
    })
    await wrapper.get('.row-actions .link').trigger('click')
    return wrapper
  }

  it('asks for candidates for the persona being edited, and says a session is reading', async () => {
    const calls: { personaId: string }[] = []
    const wrapper = await openedIdle(async (input) => {
      calls.push(input)
      return { started: true, reason: null }
    })
    await wrapper.get('.trial.proposer .link').trigger('click')
    await flushPromises()
    // The callback actually fired with the right persona — an unwired handler passes every
    // static check while doing nothing.
    expect(calls).toEqual([{ personaId: 'p1' }])
    expect(wrapper.get('.trial.proposer').text()).toContain('reading the repository')
  })

  /**
   * And a refusal is shown where the gesture was, not in a session banner: every refusal here
   * is a fact about this persona and names something to do about it.
   */
  it('shows the refusal beside the button that produced it', async () => {
    const wrapper = await openedIdle(async () => ({
      started: false,
      reason: 'Nothing has been measured and lost for "swe" yet.',
    }))
    await wrapper.get('.trial.proposer .link').trigger('click')
    await flushPromises()
    expect(wrapper.get('.trial.proposer').text()).toContain('measured and lost')
  })

  it('does not offer a proposer while a search is already being measured', async () => {
    const wrapper = await openedSearch(search())
    expect(wrapper.find('.trial.proposer').exists()).toBe(false)
  })

  const openedSearch = async (variantSearch: VariantSearch) => {
    const wrapper = mount(PersonaEditor, {
      props: {
        personas: [persona()],
        capabilities: [],
        attachments: [],
        revisions: [],
        searches: { p1: variantSearch },
      },
    })
    await wrapper.get('.row-actions .link').trigger('click')
    return wrapper
  }


  /**
   * The held-out screen on the panel. What matters is not that the numbers render — it is
   * that the two states a reader will confuse are visibly different: a candidate the screen
   * *refused* has an empty arm on purpose, and a search that was *never screened* has one
   * for an entirely different reason.
   */
  const screened = (over: Partial<NonNullable<VariantSearch['screen']>> = {}) => ({
    replaySetVersion: 3,
    detail: '6 held-out items (5 merged, 1 discarded), from 40 decided runs considered.',
    itemCount: 6,
    arms: [
      { variantId: null, decision: null, reason: null, passed: 5, failed: 1, notScored: 0, pending: 0 },
      {
        variantId: 'v1',
        decision: 'rejected' as const,
        reason: 'Rejected by the held-out screen: it passed 1 of 6 items (17%) where the prompt in use passed 5 of 6 (83%).',
        passed: 1,
        failed: 5,
        notScored: 0,
        pending: 0,
      },
      {
        variantId: 'v2',
        decision: 'admitted' as const,
        reason: 'Admitted by the held-out screen: it passed 6 of 6 items (100%) against 83% for the prompt in use.',
        passed: 6,
        failed: 0,
        notScored: 0,
        pending: 0,
      },
    ],
    ...over,
  })

  /**
   * Where the candidates came from, which is the one fact in this panel that is about the
   * *author* rather than the measurement. A human promoting a candidate is making an agent's
   * document permanent, and a session that has never done this persona's work is a different
   * witness from the run that had just finished doing it.
   */
  it('says when a separate proposer wrote the candidates, and how much it was shown', async () => {
    const wrapper = await openedSearch(
      search({
        proposer: {
          runId: 'run_proposer',
          detail:
            'Written by a separate proposer session rather than by a run of this persona: it ' +
            'was shown 2 of 19 candidates this persona has already lost.',
        },
      }),
    )
    const text = wrapper.get('.trial.search').text()
    expect(text).toContain('separate proposer session')
    expect(text).toContain('2 of 19')
  })

  /**
   * And says nothing when it was the older path. Null is "a run proposed about its own work",
   * not "a proposer with nothing to show" — a caveat printed on every search that predates
   * the proposer would be noise attached to history nobody can act on.
   */
  it('stays silent about provenance when a run proposed about its own work', async () => {
    const wrapper = await openedSearch(search())
    expect(wrapper.get('.trial.search').text()).not.toContain('proposer session')
  })

  it('names the held-out set version, because a score without one compares two things', async () => {
    const wrapper = await openedSearch(search({ screen: screened() }))
    expect(wrapper.get('.trial.search').text()).toContain('held-out set v3')
  })

  it('reports what the set left out rather than only what it holds', async () => {
    const wrapper = await openedSearch(search({ screen: screened() }))
    expect(wrapper.get('.trial.search').text()).toContain('40 decided runs considered')
  })

  it('says a search was not screened, which is not the same as nothing being admitted', async () => {
    const wrapper = await openedSearch(search({ screen: null }))
    const text = wrapper.get('.trial.search').text()
    expect(text).toContain('Not screened against held-out work')
    expect(text).not.toContain('held-out set v')
  })

  it('gives the reason a candidate was refused an arm, which is why its arm may be empty', async () => {
    const wrapper = await openedSearch(search({ screen: screened() }))
    expect(wrapper.get('.trial.search').text()).toContain('passed 1 of 6 items')
  })

  it('shows a candidate still being screened as screening, not as a verdict', async () => {
    const wrapper = await openedSearch(
      search({
        screen: screened({
          arms: [
            { variantId: null, decision: null, reason: null, passed: 6, failed: 0, notScored: 0, pending: 0 },
            { variantId: 'v1', decision: null, reason: null, passed: 2, failed: 0, notScored: 0, pending: 4 },
            { variantId: 'v2', decision: null, reason: null, passed: 0, failed: 0, notScored: 0, pending: 6 },
          ],
        }),
      }),
    )
    const text = wrapper.get('.trial.search').text()
    expect(text).toContain('4 of 6 held-out items still running')
    // A blank where a verdict is coming reads as a verdict, so it must say it is coming.
    expect(text).toContain('screening')
  })

  it('still offers to promote a rejected candidate — the screen gates measurement, not choice', async () => {
    const wrapper = await openedSearch(search({ screen: screened() }))
    const rejectedArm = wrapper.findAll('.trial.search .arms li')[1]!
    expect(rejectedArm.text()).toContain('Promote')
  })

  it('shows every arm including the prompt in use, and each candidate"s own text', async () => {
    const wrapper = await openedSearch(search())
    const panel = wrapper.get('.trial.search')
    expect(panel.text()).toContain('the prompt in use')
    expect(panel.text()).toContain('ahead of the prompt in use')
    expect(panel.text()).toContain('behind the prompt in use')
    // The document a promotion would write, on the page.
    expect(panel.text()).toContain('WRITE THE SMALLEST DIFF.')
    // And a candidate's failing check, named.
    expect(panel.text()).toContain('mostly build')
  })

  it('emits a promotion naming the candidate, and a discard naming none', async () => {
    const wrapper = await openedSearch(search())
    const promote = wrapper
      .findAll('.trial.search .arms button')
      .find((button) => button.text() === 'Promote')
    expect(promote).toBeDefined()
    await promote!.trigger('click')
    await wrapper
      .findAll('.trial.search .arms button')
      .find((button) => button.text().includes('Make this the prompt'))!
      .trigger('click')
    expect(wrapper.emitted('settle-search')).toEqual([[{ personaId: 'p1', variantId: 'v1' }]])

    const discard = wrapper
      .findAll('.trial.search .trial-actions button')
      .find((button) => button.text() === 'Discard the search')
    await discard!.trigger('click')
    await wrapper
      .findAll('.trial.search .trial-actions button')
      .find((button) => button.text().includes('Keep the prompt it has'))!
      .trigger('click')
    expect(wrapper.emitted('settle-search')?.[1]).toEqual([{ personaId: 'p1', variantId: null }])
  })

  /**
   * The verdict, and the words that keep it honest. The self-improvement loop gives the
   * measurement the last word on fitness, so a panel that showed a model's opinion without
   * saying it counts for nothing would be manufacturing evidence out of a second opinion.
   */
  it('shows the verifier"s verdict and says it counts for nothing', async () => {
    const wrapper = await openedSearch(
      search({
        verifier: {
          pickedVariantId: 'v1',
          reason: 'A run following B would miss the integration suite under packages/db.',
          detail: 'The verifier disagrees with the runs.',
        },
      }),
    )
    const verdict = wrapper.get('.trial.search .verdict')
    expect(verdict.text()).toContain('counted in nothing')
    expect(verdict.text()).toContain('The verifier disagrees with the runs.')
    // Its reason, verbatim — an assertion a human can check is the point of the session.
    expect(verdict.text()).toContain('packages/db')
  })

  it('shows no verdict block before the verifier has one', async () => {
    const wrapper = await openedSearch(search())
    expect(wrapper.find('.trial.search .verdict').exists()).toBe(false)
  })

  it('offers no panel for a persona nothing is being searched over', async () => {
    const wrapper = mount(PersonaEditor, {
      props: { personas: [persona()], capabilities: [], attachments: [], revisions: [] },
    })
    await wrapper.get('.row-actions .link').trigger('click')
    expect(wrapper.find('.trial.search').exists()).toBe(false)
  })
})
