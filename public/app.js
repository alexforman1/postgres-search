const form = document.getElementById('search-form')
const input = document.getElementById('q')
const list = document.getElementById('suggestions')
const statusLine = document.getElementById('status')
const resultsList = document.getElementById('results')
const facetsBox = document.getElementById('facets')

let filters = {}
let active = -1
let timer

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  if (text !== undefined) node.textContent = text
  return node
}

async function get(path, params) {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`)
  if (!res.ok) throw new Error(`${path} returned ${res.status}`)
  return res.json()
}

// Typeahead

input.addEventListener('input', () => {
  clearTimeout(timer)
  timer = setTimeout(suggest, 120)
})

async function suggest() {
  const q = input.value.trim()
  if (!q) return closeList()
  const { suggestions } = await get('/suggest', { q })
  // Drop the answer if the user kept typing while it was in flight.
  if (q !== input.value.trim()) return
  list.replaceChildren(...suggestions.map((s, i) => {
    const option = el('li', { id: `option-${i}`, role: 'option', 'aria-selected': 'false' }, s.name)
    option.addEventListener('mousedown', event => {
      event.preventDefault()
      choose(s.name)
    })
    return option
  }))
  active = -1
  list.hidden = suggestions.length === 0
  input.setAttribute('aria-expanded', String(!list.hidden))
  input.removeAttribute('aria-activedescendant')
}

function closeList() {
  list.hidden = true
  list.replaceChildren()
  active = -1
  input.setAttribute('aria-expanded', 'false')
  input.removeAttribute('aria-activedescendant')
}

function highlight(index) {
  const options = list.querySelectorAll('[role=option]')
  if (!options.length) return
  active = (index + options.length) % options.length
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === active)))
  input.setAttribute('aria-activedescendant', options[active].id)
}

input.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    highlight(active + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    highlight(active - 1)
  } else if (event.key === 'Escape') {
    closeList()
  } else if (event.key === 'Enter' && active >= 0) {
    event.preventDefault()
    choose(list.querySelectorAll('[role=option]')[active].textContent)
  }
})

input.addEventListener('blur', closeList)

function choose(name) {
  input.value = name
  closeList()
  filters = {}
  run()
}

// Results and facets

form.addEventListener('submit', event => {
  event.preventDefault()
  closeList()
  filters = {}
  run()
})

async function run() {
  const q = input.value.trim()
  if (!q) return
  statusLine.textContent = 'Searching...'
  try {
    const params = { q, filters: JSON.stringify(filters) }
    const [found, counted] = await Promise.all([get('/search', params), get('/facets', params)])
    renderResults(found)
    renderFacets(counted.facets)
  } catch {
    statusLine.textContent = 'Search failed. See the server log.'
  }
}

function renderResults({ results, jev }) {
  const jevNote = jev.ran ? `Jev ran in ${jev.ms} ms.` : jev.error ? `Jev off: ${jev.error}.` : 'Jev skipped.'
  statusLine.textContent = `${results.length} results. ${jevNote}`
  resultsList.replaceChildren(...results.map(r => {
    const item = el('li')
    item.append(el('span', { class: 'name' }, r.name))
    if (r.other_names) item.append(el('span', { class: 'other' }, r.other_names))
    const meta = [r.facets.category, `matched by: ${r.step}`].filter(Boolean).join(' | ')
    item.append(el('span', { class: 'meta' }, meta))
    if (r.sunk) item.append(el('span', { class: 'sunk' }, 'Moved down by Jev'))
    return item
  }))
}

function renderFacets(facets) {
  facetsBox.replaceChildren(...Object.entries(facets).map(([facet, values]) => {
    const group = el('section')
    group.append(el('h2', {}, facet))
    const options = el('ul')
    for (const { value, count } of values) {
      const pressed = filters[facet] === value
      const button = el('button', { type: 'button', 'aria-pressed': String(pressed) }, `${value} (${count})`)
      button.addEventListener('click', () => {
        if (pressed) delete filters[facet]
        else filters[facet] = value
        run()
      })
      const item = el('li')
      item.append(button)
      options.append(item)
    }
    group.append(options)
    return group
  }))
}
