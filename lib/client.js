window.__ModuleLoader__.load({ id: "dsh-share-pack", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  // Browser half: a Share button in the Session header that turns the current
  // conversation into a pasteable handoff link and copies it to the clipboard.
  // No JSX and no CSS files: only react from the shell's baseline module table.

  const React = require('react')
  const h = React.createElement
  const { useState } = React

  const SLOT = 'conversation.session.header.actions'

  const style = {
    button: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '28px',
      padding: '0 8px',
      borderRadius: '6px',
      border: '1px solid currentColor',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
      opacity: 0.85,
    },
  }

  function ShareButton(props) {
    const [state, setState] = useState('idle')
    const [error, setError] = useState('')
    const [chars, setChars] = useState(0)
    const sessionId = (props && (props.sessionId || (props.session && props.session.id))) || ''

    const label = state === 'busy'
      ? '生成中…'
      : state === 'copied'
        ? '已复制 · ' + chars + ' 字'
        : state === 'error' ? '分享失败' : '分享'

    const onClick = async () => {
      if (state === 'busy') return
      setState('busy')
      setError('')
      try {
        const query = sessionId ? '?session=' + encodeURIComponent(sessionId) : ''
        const response = await fetch('/dsh-share/pack' + query, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (!body || body.ok !== true) throw new Error((body && body.error) || 'host refused')
        setChars(body.chars || body.link.length)
        try {
          await navigator.clipboard.writeText(body.link)
          setState('copied')
        } catch (clipboardError) {
          // Clipboard needs a user gesture and a secure context; failing that,
          // fall back to a textarea the user can copy from.
          window.prompt('已生成分享链接，复制下面这行：', body.link)
          setState('copied')
        }
        setTimeout(() => setState('idle'), 2500)
      } catch (failure) {
        setError(String((failure && failure.message) || failure))
        setState('error')
        setTimeout(() => setState('idle'), 4000)
      }
    }

    return h(
      'button',
      {
        type: 'button',
        title: state === 'error' ? error : '把当前对话压缩成可粘贴的交接链接',
        style: style.button,
        onClick,
      },
      label,
    )
  }

  function apply(ctx) {
    ctx.effect(
      () =>
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: 'dsh-share-pack', order: 60 }, ShareButton),
        ),
      'dsh-share-pack: share button',
    )
  }

  module.exports = { name: 'dsh-share-pack', inject: ['slots'], apply: apply }
  return module.exports
} });
