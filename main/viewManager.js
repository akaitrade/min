var viewMap = {} // id: view
var viewStateMap = {} // id: view state

var temporaryPopupViews = {} // id: view

// Blockchain resolver for tx: URLs
const WebSocket = require('ws')
const zlib = require('zlib')
const fileSystem = require('fs')
const pathUtil = require('path')
const os = require('os')
const http = require('http')

// Create a simple HTTP server for serving blockchain content
let blockchainContentServer = null
let serverPort = 38429 // Use a specific port for blockchain content

function startBlockchainContentServer() {
  if (blockchainContentServer) {
    return Promise.resolve(serverPort)
  }
  
  return new Promise((resolve, reject) => {
    blockchainContentServer = http.createServer((req, res) => {
      console.log('HTTP request received:', req.method, req.url)
      console.log('Available content keys:', Object.keys(blockchainContentStore))
      
      // Enable CORS and proper headers
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' ws: wss: data:")
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }
      
      // Serve stored content based on URL path
      const urlPath = req.url.slice(1) // Remove leading slash
      console.log('Looking for content with key:', urlPath)
      const content = blockchainContentStore[urlPath]
      
      if (content) {
        console.log('Content found, length:', content.length)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.writeHead(200)
        res.end(content)
      } else {
        console.log('Content not found for key:', urlPath)
        res.writeHead(404)
        res.end('Content not found')
      }
    })
    
    blockchainContentServer.listen(serverPort, 'localhost', (err) => {
      if (err) {
        reject(err)
      } else {
        console.log(`Blockchain content server started on http://localhost:${serverPort}`)
        resolve(serverPort)
      }
    })
  })
}

// Store for blockchain content
const blockchainContentStore = {}

// Track original blockchain URLs for display purposes
const blockchainURLMapping = {} // maps localhost URLs to original tx: URLs

const blockchainResolver = {
  defaultNode: 'ws://109.199.97.4:9095/',
  
  parseTransactionID: function (url) {
    if (!url.startsWith('tx:')) {
      return null
    }
    
    const txPart = url.slice(3)
    const [txId, index] = txPart.split('.')
    
    return {
      txId: txId,
      index: index ? parseInt(index, 10) : 0
    }
  },
  
  getTransaction: function (txId, index = 0, nodeUrl = null) {
    return new Promise((resolve, reject) => {
      const wsUrl = nodeUrl || blockchainResolver.defaultNode
      const ws = new WebSocket(wsUrl)
      
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Request timeout'))
      }, 10000)
      
      ws.on('open', () => {
        const request = {
          id: 'req-1',
          type: 3,
          data: {
            poolSeq: parseInt(txId),
            index: index
          }
        }
        
        ws.send(JSON.stringify(request))
      })
      
      ws.on('message', (data) => {
        clearTimeout(timeout)
        try {
          const response = JSON.parse(data.toString())
          ws.close()
          
          if (response.data && response.data.found) {
            resolve(response.data)
          } else {
            reject(new Error('Transaction not found'))
          }
        } catch (error) {
          reject(new Error('Invalid response format'))
        }
      })
      
      ws.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  },
  
  decodeUserFields: function (userFields) {
    try {
      if (!userFields || userFields === '') {
        return null
      }
      
      const base64Decoded = Buffer.from(userFields, 'base64')
      const zlibDecompressed = zlib.inflateSync(base64Decoded)
      return zlibDecompressed.toString('utf8')
    } catch (error) {
      throw new Error('Failed to decode userFields: ' + error.message)
    }
  },
  
  createHTMLPage: function (htmlContent, txId, index) {
    // Don't remove scripts for blockchain content - we want full functionality
    // Just add our blockchain header if the content doesn't already have proper structure
    if (htmlContent.includes('<!DOCTYPE html>') && htmlContent.includes('<html')) {
      // Content already has full HTML structure, return as-is but add base tag for relative URLs
      return htmlContent.replace('<head>', `<head>
        <base href="http://localhost:38429/">
        <meta name="blockchain-tx-id" content="${txId}">
        <meta name="blockchain-tx-index" content="${index}">`)
    } else {
      // Wrap content in basic HTML structure
      return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Blockchain Content - tx:${txId}.${index}</title>
    <base href="http://localhost:38429/">
    <meta name="blockchain-tx-id" content="${txId}">
    <meta name="blockchain-tx-index" content="${index}">
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background-color: #f5f5f5; 
        }
        .blockchain-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 20px;
            margin: -20px -20px 20px -20px;
            border-radius: 0 0 8px 8px;
        }
        .blockchain-info {
            font-size: 14px;
            opacity: 0.9;
            margin-top: 5px;
        }
        .content-container {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
    </style>
</head>
<body>
    <div class="blockchain-header">
        <h2>📋 Blockchain Content</h2>
        <div class="blockchain-info">
            Transaction ID: ${txId} | Index: ${index}
        </div>
    </div>
    <div class="content-container">
        ${htmlContent}
    </div>
</body>
</html>`
    }
  },
  
  resolveTransaction: async function (url) {
    try {
      const parsed = blockchainResolver.parseTransactionID(url)
      if (!parsed) {
        throw new Error('Invalid transaction URL format')
      }
      
      const txData = await blockchainResolver.getTransaction(parsed.txId, parsed.index)
      
      if (!txData.userFields) {
        throw new Error('No user data found in transaction')
      }
      
      const htmlContent = blockchainResolver.decodeUserFields(txData.userFields)
      if (!htmlContent) {
        throw new Error('Could not decode user data')
      }
      
      return blockchainResolver.createHTMLPage(htmlContent, parsed.txId, parsed.index)
    } catch (error) {
      return blockchainResolver.createErrorPage(error.message, url)
    }
  },
  
  createErrorPage: function (errorMessage, url) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Blockchain Resolution Error</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background-color: #f5f5f5; 
        }
        .error-container {
            background: white;
            border-radius: 8px;
            padding: 30px;
            text-align: center;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 600px;
            margin: 50px auto;
        }
        .error-icon {
            font-size: 48px;
            color: #e74c3c;
            margin-bottom: 20px;
        }
        .error-title {
            color: #e74c3c;
            font-size: 24px;
            margin-bottom: 15px;
        }
        .error-message {
            color: #666;
            font-size: 16px;
            margin-bottom: 20px;
        }
        .error-url {
            background: #f8f9fa;
            padding: 10px;
            border-radius: 4px;
            font-family: monospace;
            word-break: break-all;
            margin-top: 15px;
        }
    </style>
</head>
<body>
    <div class="error-container">
        <div class="error-icon">⚠️</div>
        <h2 class="error-title">Unable to Resolve Blockchain Content</h2>
        <p class="error-message">${errorMessage}</p>
        <div class="error-url">${url}</div>
    </div>
</body>
</html>`
  }
}

// rate limit on "open in app" requests
var globalLaunchRequests = 0

function getDefaultViewWebPreferences () {
  return (
    {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      scrollBounce: true,
      safeDialogs: true,
      safeDialogsMessage: 'Prevent this page from creating additional dialogs',
      preload: __dirname + '/dist/preload.js',
      contextIsolation: true,
      sandbox: false,  // Disable sandbox for blockchain content
      enableRemoteModule: false,
      allowPopups: false,
      // partition: partition || 'persist:webcontent',
      enableWebSQL: false,
      autoplayPolicy: (settings.get('enableAutoplay') ? 'no-user-gesture-required' : 'user-gesture-required'),
      // match Chrome's default for anti-fingerprinting purposes (Electron defaults to 0)
      minimumFontSize: 6,
      javascript: !(settings.get('filtering')?.contentTypes?.includes('script')),
      webSecurity: false  // Disable web security for blockchain content
    }
  )
}

function createView (existingViewId, id, webPreferences, boundsString, events) {
  if (viewStateMap[id]) {
    console.warn("Creating duplicate view")
  }

  const viewPrefs = Object.assign({}, getDefaultViewWebPreferences(), webPreferences)

  viewStateMap[id] = {
    loadedInitialURL: false,
    hasJS: viewPrefs.javascript // need this later to see if we should swap the view for a JS-enabled one
  }

  let view
  if (existingViewId) {
    view = temporaryPopupViews[existingViewId]
    delete temporaryPopupViews[existingViewId]

    // the initial URL has already been loaded, so set the background color
    view.setBackgroundColor('#fff')
    viewStateMap[id].loadedInitialURL = true
  } else {
    view = new WebContentsView({ webPreferences: viewPrefs })
  }

  events.forEach(function (event) {
    view.webContents.on(event, function (e) {
      var args = Array.prototype.slice.call(arguments).slice(1)

      const eventTarget = getWindowFromViewContents(view) || windows.getCurrent()

      if (!eventTarget) {
        //this can happen during shutdown - windows can be destroyed before the corresponding views, and the view can emit an event during that time
        return
      }

      getWindowWebContents(eventTarget).send('view-event', {
        tabId: id,
        event: event,
        args: args
      })
    })
  })

  view.webContents.on('select-bluetooth-device', function (event, deviceList, callback) {
    event.preventDefault()
    callback('')
  })

  view.webContents.setWindowOpenHandler(function (details) {
    if (details.url && !filterPopups(details.url)) {
      return {
        action: 'deny'
      }
    }

    /*
      Opening a popup with window.open() generally requires features to be set
      So if there are no features, the event is most likely from clicking on a link, which should open a new tab.
      Clicking a link can still have a "new-window" or "foreground-tab" disposition depending on which keys are pressed
      when it is clicked.
      (https://github.com/minbrowser/min/issues/1835)
    */
    if (!details.features) {
      const eventTarget = getWindowFromViewContents(view) || windows.getCurrent()

      getWindowWebContents(eventTarget).send('view-event', {
        tabId: id,
        event: 'new-tab',
        args: [details.url, !(details.disposition === 'background-tab')]
      })
      return {
        action: 'deny'
      }
    }

    return {
      action: 'allow',
      createWindow: function (options) {
        const view = new WebContentsView({ webPreferences: getDefaultViewWebPreferences(), webContents: options.webContents })

        var popupId = Math.random().toString()
        temporaryPopupViews[popupId] = view

        const eventTarget = getWindowFromViewContents(view) || windows.getCurrent()

        getWindowWebContents(eventTarget).send('view-event', {
          tabId: id,
          event: 'did-create-popup',
          args: [popupId, details.url]
        })

        return view.webContents
      }
    }
  })

  view.webContents.on('ipc-message', function (e, channel, data) {
    var senderURL
    try {
      senderURL = e.senderFrame.url
    } catch (err) {
      // https://github.com/minbrowser/min/issues/2052
      console.warn('dropping message because senderFrame is destroyed', channel, data, err)
      return
    }

    const eventTarget = getWindowFromViewContents(view) || windows.getCurrent()

    if (!eventTarget) {
      //this can happen during shutdown - windows can be destroyed before the corresponding views, and the view can emit an event during that time
      return
    }

    getWindowWebContents(eventTarget).send('view-ipc', {
      id: id,
      name: channel,
      data: data,
      frameId: e.frameId,
      frameURL: senderURL
    })
  })

  // Open a login prompt when site asks for http authentication
  view.webContents.on('login', (event, authenticationResponseDetails, authInfo, callback) => {
    if (authInfo.scheme !== 'basic') { // Only for basic auth
      return
    }
    event.preventDefault()
    var title = l('loginPromptTitle').replace('%h', authInfo.host)
    createPrompt({
      text: title,
      values: [{ placeholder: l('username'), id: 'username', type: 'text' },
        { placeholder: l('password'), id: 'password', type: 'password' }],
      ok: l('dialogConfirmButton'),
      cancel: l('dialogSkipButton'),
      width: 400,
      height: 200
    }, function (result) {
      // resend request with auth credentials
      callback(result.username, result.password)
    })
  })

  // show an "open in app" prompt for external protocols

  function handleExternalProtocol (e, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
    var knownProtocols = ['http', 'https', 'file', 'min', 'about', 'data', 'javascript', 'chrome', 'tx'] // TODO anything else?
    if (!knownProtocols.includes(url.split(':')[0])) {
      var externalApp = app.getApplicationNameForProtocol(url)
      if (externalApp) {
        var sanitizedName = externalApp.replace(/[^a-zA-Z0-9.]/g, '')
        if (globalLaunchRequests < 2) {
          globalLaunchRequests++
          setTimeout(function () {
            globalLaunchRequests--
          }, 20000)
          var result = electron.dialog.showMessageBoxSync({
            type: 'question',
            buttons: ['OK', 'Cancel'],
            message: l('openExternalApp').replace('%s', sanitizedName).replace(/\\/g, ''),
            detail: url.length > 160 ? url.substring(0, 160) + '...' : url
          })

          if (result === 0) {
            electron.shell.openExternal(url)
          }
        }
      }
    }
  }

  view.webContents.on('did-start-navigation', handleExternalProtocol)
  /*
  It's possible for an HTTP request to redirect to an external app link
  (primary use case for this is OAuth from desktop app > browser > back to app)
  and did-start-navigation isn't (always?) emitted for redirects, so we need this handler as well
  */
  view.webContents.on('will-redirect', handleExternalProtocol)

  /*
  the JS setting can only be set when the view is created, so swap the view on navigation if the setting value changed
  This can occur if the user manually changed the setting, or if we are navigating between an internal page (always gets JS)
  and an external one
  */
  view.webContents.on('did-start-navigation', function (event) {
    if (event.isMainFrame && !event.isSameDocument) {
      const hasJS = viewStateMap[id].hasJS
      const shouldHaveJS = (!(settings.get('filtering')?.contentTypes?.includes('script'))) || event.url.startsWith('min://')
      if (hasJS !== shouldHaveJS) {
        setTimeout(function () {
          view.webContents.stop()
          const currentWindow = getWindowFromViewContents(view)
          destroyView(id)
          const newView = createView(existingViewId, id, Object.assign({}, webPreferences, { javascript: shouldHaveJS }), boundsString, events)
          loadURLInView(id, event.url, currentWindow)

          if (currentWindow) {
            setView(id, getWindowWebContents(currentWindow))
            focusView(id)
          }
        }, 0)
      }
    }
  })

  view.setBounds(JSON.parse(boundsString))

  viewMap[id] = view

  return view
}

function destroyView (id) {
  if (!viewMap[id]) {
    return
  }

  windows.getAll().forEach(function (window) {
    if (windows.getState(window).selectedView === id) {
      window.getContentView().removeChildView(viewMap[id])
      windows.getState(window).selectedView = null
    }
  })
  viewMap[id].webContents.destroy()

  delete viewMap[id]
  delete viewStateMap[id]
}

function destroyAllViews () {
  for (const id in viewMap) {
    destroyView(id)
  }
}

function setView (id, senderContents) {
  const win = windows.windowFromContents(senderContents).win

  // changing views can cause flickering, so we only want to call it if the view is actually changing
  // see https://github.com/minbrowser/min/issues/1966
  if (windows.getState(win).selectedView !== viewMap[id]) {
    //remove all prior views
    win.getContentView().children.slice(1).forEach(child => win.getContentView().removeChildView(child))
    if (viewStateMap[id].loadedInitialURL) {
      win.getContentView().addChildView(viewMap[id])
    } else {
      win.getContentView().removeChildView(viewMap[id])
    }
    windows.getState(win).selectedView = id
  }
}

function setBounds (id, bounds) {
  if (viewMap[id]) {
    viewMap[id].setBounds(bounds)
  }
}

function focusView (id) {
  // empty views can't be focused because they won't propogate keyboard events correctly, see https://github.com/minbrowser/min/issues/616
  // also, make sure the view exists, since it might not if the app is shutting down
  if (viewMap[id] && (viewMap[id].webContents.getURL() !== '' || viewMap[id].webContents.isLoading())) {
    viewMap[id].webContents.focus()
    return true
  } else if (getWindowFromViewContents(viewMap[id])) {
    getWindowWebContents(getWindowFromViewContents(viewMap[id])).focus()
    return true
  }
}

function hideCurrentView (senderContents) {
  const win = windows.windowFromContents(senderContents).win
  const currentId = windows.getState(win).selectedView
  if (currentId) {
    win.getContentView().removeChildView(viewMap[currentId])
    windows.getState(win).selectedView = null
    if (win.isFocused()) {
      getWindowWebContents(win).focus()
    }
  }
}

function getView (id) {
  return viewMap[id]
}

function getTabIDFromWebContents (contents) {
  for (var id in viewMap) {
    if (viewMap[id].webContents === contents) {
      return id
    }
  }
}

function getWindowFromViewContents (webContents) {
  const viewId = Object.keys(viewMap).find(id => viewMap[id].webContents === webContents)
  return windows.getAll().find(win => windows.getState(win).selectedView === viewId)
}

ipc.on('createView', function (e, args) {
  createView(args.existingViewId, args.id, args.webPreferences, args.boundsString, args.events)
})

ipc.on('destroyView', function (e, id) {
  destroyView(id)
})

ipc.on('destroyAllViews', function () {
  destroyAllViews()
})

ipc.on('setView', function (e, args) {
  setView(args.id, e.sender)
  setBounds(args.id, args.bounds)
  if (args.focus && BrowserWindow.fromWebContents(e.sender) && BrowserWindow.fromWebContents(e.sender).isFocused()) {
    const couldFocus = focusView(args.id)
    if (!couldFocus) {
      e.sender.focus()
    }
  }
})

ipc.on('setBounds', function (e, args) {
  setBounds(args.id, args.bounds)
})

ipc.on('focusView', function (e, id) {
  focusView(id)
})

ipc.on('hideCurrentView', function (e) {
  hideCurrentView(e.sender)
})

function loadURLInView (id, url, win) {
  // wait until the first URL is loaded to set the background color so that new tabs can use a custom background
  if (!viewStateMap[id].loadedInitialURL) {
    // Give the site a chance to display something before setting the background, in case it has its own dark theme
    viewMap[id].webContents.once('dom-ready', function() {
      viewMap[id].setBackgroundColor('#fff')
    })
    // If the view has no URL, it won't be attached yet
    if (win && id === windows.getState(win).selectedView) {
      win.getContentView().addChildView(viewMap[id])
    }
  }
  
  // Handle blockchain transaction URLs
  if (url.startsWith('tx:')) {
    console.log('Handling blockchain URL:', url)
    
    blockchainResolver.resolveTransaction(url).then(htmlContent => {
      console.log('Blockchain content resolved, length:', htmlContent.length)
      
      startBlockchainContentServer().then(port => {
        // Store content in server and load via HTTP
        const contentId = `tx-${id}-${Date.now()}`
        blockchainContentStore[contentId] = htmlContent
        
        console.log('Stored content with ID:', contentId)
        console.log('Available content IDs:', Object.keys(blockchainContentStore))
        
        // Load via HTTP server to allow WebSocket connections
        const httpUrl = `http://localhost:${port}/${contentId}`
        console.log('Loading URL:', httpUrl)
        
        // Store mapping for URL display
        blockchainURLMapping[httpUrl] = url
        blockchainURLMapping[`http://localhost:${port}/${contentId}`] = url
        
        viewMap[id].webContents.loadURL(httpUrl)
        
        // Immediately update the tab URL to show the original tx: URL
        setTimeout(() => {
          const win = windows.windowFromContents(viewMap[id].webContents)?.win
          if (win) {
            win.webContents.send('view-event', {
              tabId: id,
              event: 'did-navigate',
              args: [url, false, true] // original tx: URL, not in place, main frame
            })
          }
        }, 100)
        
        // Clean up stored content after a delay
        setTimeout(() => {
          delete blockchainContentStore[contentId]
          // Clean up URL mapping too
          delete blockchainURLMapping[httpUrl]
          delete blockchainURLMapping[`http://localhost:${port}/${contentId}`]
          console.log('Cleaned up content:', contentId)
        }, 300000) // 5 minutes
      }).catch(serverError => {
        console.error('Failed to start content server:', serverError)
        viewMap[id].webContents.loadURL('about:blank')
      })
    }).catch(error => {
      console.error('Blockchain resolution error:', error)
      
      startBlockchainContentServer().then(port => {
        const errorHTML = blockchainResolver.createErrorPage(error.message, url)
        const contentId = `tx-error-${id}-${Date.now()}`
        blockchainContentStore[contentId] = errorHTML
        
        console.log('Stored error content with ID:', contentId)
        
        const httpUrl = `http://localhost:${port}/${contentId}`
        
        // Store mapping for URL display
        blockchainURLMapping[httpUrl] = url
        
        viewMap[id].webContents.loadURL(httpUrl)
        
        // Immediately update the tab URL to show the original tx: URL
        setTimeout(() => {
          const win = windows.windowFromContents(viewMap[id].webContents)?.win
          if (win) {
            win.webContents.send('view-event', {
              tabId: id,
              event: 'did-navigate',
              args: [url, false, true] // original tx: URL, not in place, main frame
            })
          }
        }, 100)
        
        setTimeout(() => {
          delete blockchainContentStore[contentId]
          // Clean up URL mapping too
          delete blockchainURLMapping[httpUrl]
        }, 300000)
      }).catch(serverError => {
        console.error('Failed to start content server:', serverError)
        viewMap[id].webContents.loadURL('about:blank')
      })
    })
  } else {
    viewMap[id].webContents.loadURL(url)
  }
  
  viewStateMap[id].loadedInitialURL = true
}

ipc.on('loadURLInView', function (e, args) {
  const win = windows.windowFromContents(e.sender)?.win
  loadURLInView(args.id, args.url, win)
})

// Handle requests for original blockchain URLs
ipc.handle('getBlockchainURL', function (e, httpUrl) {
  console.log('IPC getBlockchainURL called with:', httpUrl)
  console.log('Available mappings:', Object.keys(blockchainURLMapping))
  const result = blockchainURLMapping[httpUrl] || null
  console.log('Returning mapping result:', result)
  return result
})

ipc.on('callViewMethod', function (e, data) {
  var error, result
  try {
    var webContents = viewMap[data.id].webContents
    var methodOrProp = webContents[data.method]
    if (methodOrProp instanceof Function) {
      // call function
      result = methodOrProp.apply(webContents, data.args)
    } else {
      // set property
      if (data.args && data.args.length > 0) {
        webContents[data.method] = data.args[0]
      }
      // read property
      result = methodOrProp
    }
  } catch (e) {
    error = e
  }
  if (result instanceof Promise) {
    result.then(function (result) {
      if (data.callId) {
        e.sender.send('async-call-result', { callId: data.callId, error: null, result })
      }
    })
    result.catch(function (error) {
      if (data.callId) {
        e.sender.send('async-call-result', { callId: data.callId, error, result: null })
      }
    })
  } else if (data.callId) {
    e.sender.send('async-call-result', { callId: data.callId, error, result })
  }
})

ipc.handle('getNavigationHistory', function (e, id) {
  if (!viewMap[id]?.webContents) {
    return null
  }
  const entries = []
  const activeIndex = viewMap[id].webContents.navigationHistory.getActiveIndex()
  const size = viewMap[id].webContents.navigationHistory.length()

  for (let i = 0; i < size; i++) {
    entries.push(viewMap[id].webContents.navigationHistory.getEntryAtIndex(i))
  }

  return {
    activeIndex,
    entries
  }
})

ipc.on('getCapture', function (e, data) {
  var view = viewMap[data.id]
  if (!view) {
    // view could have been destroyed
    return
  }

  view.webContents.capturePage().then(function (img) {
    var size = img.getSize()
    if (size.width === 0 && size.height === 0) {
      return
    }
    img = img.resize({ width: data.width, height: data.height })
    e.sender.send('captureData', { id: data.id, url: img.toDataURL() })
  })
})

ipc.on('saveViewCapture', function (e, data) {
  var view = viewMap[data.id]
  if (!view) {
    // view could have been destroyed
  }

  view.webContents.capturePage().then(function (image) {
    view.webContents.downloadURL(image.toDataURL())
  })
})

global.getView = getView
