'use strict'

var fs = require('fs')
var path = require('path')
var uncached = require('require-uncached')
var heading = require('mdast-util-heading-range')
var trimTrailingLines = require('trim-trailing-lines')
var unquote = require('unquote')
var cept = require('cept')
var unified = require('unified')
var markdown = require('remark-parse')
var resolveFrom = require('resolve-from')

module.exports = usage

var exists = fs.existsSync
var read = fs.readFileSync
var write = fs.writeFileSync
var remove = fs.unlinkSync
var resolve = path.resolve

var processor = unified().use(markdown)

/* List of locations to look for an example. */
var EXAMPLES = [
  'docs/example.js',
  'doc/example.js',
  'examples',
  'example',
  'example.js'
]

/* Expressions. */
var EXPRESSION_LOG = /(console\.log\()(.+)(\);?)/g
var EXPRESSION_REQUIRE = /(require\()(.+)(\);?)/g
var EXPRESSION_COMMENT = /^(\s*)(\/\/)(\s*)(.+)/

/* Constants. */
var DEFAULT_HEADING = 'usage'

/* Post-process the example document. */
function postprocess(value, logs, options) {
  var tokens = []
  var start = 0
  var match
  var content
  var info
  var parameters
  var end
  var markdown

  EXPRESSION_LOG.lastIndex = 0
  match = EXPRESSION_LOG.exec(value)

  while (match) {
    end = EXPRESSION_LOG.lastIndex

    content = value.slice(start, end - match[0].length)

    parameters = match[2].split(/\s*,\s*/)

    info = parameters[0]
    info = unquote(info.trim())
    info = logs[info]

    if (info && info.value) {
      tokens = tokens.concat(script(content, options), log(info))
    } else {
      parameters = parameters.slice(1).join(', ')

      tokens = tokens.concat(
        script(content + match[1] + parameters + match[3], options)
      )
    }

    start = end
    match = EXPRESSION_LOG.exec(value)
  }

  if (start < value.length) {
    tokens = tokens.concat(script(value.slice(start), options))
  }

  markdown = []

  tokens.forEach(each)

  markdown = markdown.filter(filter)

  return markdown

  function each(token) {
    var prev
    var lang

    if (token.type === 'markdown') {
      markdown = markdown.concat(parse(token.value))
    } else {
      prev = markdown[markdown.length - 1]
      lang = 'lang' in token ? token.lang : token.type

      if (prev && prev.type === 'code' && prev.lang === lang) {
        prev.value += token.value ? '\n' + token.value : ''
      } else {
        markdown.push({
          type: 'code',
          lang: lang,
          value: token.value
        })
      }
    }
  }

  function filter(token) {
    if ('value' in token) {
      token.value = trimTrailingLines(token.value)

      return token.value !== ''
    }

    return true
  }
}

/* Update the example section. */
function usage(options) {
  var settings = {}
  var pack
  var main
  var example
  var name
  var cwd
  var header

  if (!options) {
    options = {}
  }

  cwd = options.cwd || process.cwd()

  try {
    pack = require(resolve(cwd, 'package.json'))
  } catch (error) {
    pack = {}
  }

  name = options.name || pack.name || null

  main = resolve(cwd, options.main || pack.main || 'index.js')

  example = options.example

  if (example) {
    example = require.resolve(resolve(cwd, example))
  } else {
    EXAMPLES.some(some)
  }

  settings.cwd = cwd
  settings.name = name
  settings.main = main
  settings.example = example

  header = toExpression(options.heading || DEFAULT_HEADING)

  return transform

  function transform(tree) {
    heading(tree, header, runFactory(settings))
  }

  function some(filepath) {
    filepath = resolve(cwd, filepath)

    if (exists(filepath)) {
      example = require.resolve(filepath)
      return true
    }

    return false
  }
}

/* Construct a transformer based on `options`. */
function runFactory(options) {
  return run

  /* Add an example section based on a valid example
   * JavaScript document to a `Usage` section. */
  function run(start, nodes, end) {
    var logs = {}
    var example = options.example
    var source
    var tmp
    var stop

    if (!exists(example)) {
      throw new Error(
        'Missing example: `' +
          example +
          '`. ' +
          'Pass an `example` or use a file at: ' +
          EXAMPLES.join(', ')
      )
    }

    tmp = example + '-tmp'

    source = preprocess(read(example, 'utf-8'))

    write(tmp, source, 'utf-8')

    /* To Do: better tmp file management. */
    stop = cept(console, 'log', intercept)

    try {
      uncached(tmp)
    } catch (error) {
      error.message =
        'Invalid example `' +
        example +
        '`. ' +
        'Ensure example is a valid JavaScript file:\n\n' +
        error.message

      throw error
    } finally {
      stop()

      /* istanbul ignore next */
      if (exists(tmp)) {
        remove(tmp)
      }
    }

    /* Add markdown. */
    return [start].concat(postprocess(source, logs, options), end)

    function intercept(id, lang, value) {
      if (!value) {
        value = lang
        lang = null
      }

      if (typeof value === 'string' && typeof id === 'string') {
        logs[id] = {id: id, lang: lang, value: value}
      }
    }
  }
}

/* Transform a script into an intermediate nodes,
 * removes the IDs from `console.log` invocations,
 * and resolves the main `require` call. */
function script(source, options) {
  var tokens

  /* Make sure the require to the main module
   * is showed as if it was a require from
   * `./node_modules`.
   *
   * For example, when the example file
   * (`test/example.js`) requires the main file (as
   * listed in `test/package.json`, `main: "module.js"`)
   * as `./module`, it is replaced with `test`. */
  source = source.replace(EXPRESSION_REQUIRE, replace)

  /* Transform comments into markdown: */
  tokens = []

  source.split('\n').forEach(each)

  return tokens

  function replace($0, $1, $2, $3) {
    var filepath = resolveFrom.silent(
      path.dirname(options.example),
      unquote($2)
    )
    var quote

    if (options.main === filepath && options.name) {
      /* Honour quote style. */
      quote = $2.charAt(0)

      return $1 + quote + options.name + quote + $3
    }

    return $0
  }

  function each(line) {
    var match = line.match(EXPRESSION_COMMENT)

    tokens.push({
      type: match ? 'markdown' : 'javascript',
      value: match ? match[4] : line
    })
  }
}

/* Preprocess `value` to add IDs to `console.log` invocations. */
function preprocess(value) {
  var index = 0

  return value.replace(EXPRESSION_LOG, replace)

  function replace($0, $1, $2, $3) {
    index++
    return $1 + '"remark-usage-' + index + '",' + $2 + $3
  }
}

/* Parse markdown into nodes, without positional
 * information. */
function parse(value) {
  return processor.parse(value, {position: false}).children
}

/* Transform a log into an mdast `code` node. */
function log(info) {
  return {type: 'code', lang: info.lang, value: info.value}
}

/* Transform a string into an applicable expression. */
function toExpression(value) {
  return new RegExp('^(' + value + ')$', 'i')
}
