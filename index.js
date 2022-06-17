async function setupPlugin({ config, global, storage }) {
    if (!config.shopifyStore) {
        throw new Error("Please set the 'shopifyStore' config value")
    }

    if (!config.shopifyAccessToken) {
        throw new Error("Please set the 'shopifyAccessToken' config value")
    }

    global.defaultHeaders = {
        headers: {
            'X-Shopify-Access-Token': `${config.shopifyAccessToken}`,
        },
    }

    const authResponse = await fetchWithRetry(
        `https://${config.shopifyStore}.myshopify.com/admin/api/2022-01/orders.json?limit=1`,
        global.defaultHeaders
    )

    if (!statusOk(authResponse)) {
        throw new Error('Unable to connect to Shopify. Please make sure your Access Token is correct.')
    }
}

async function fetchAllOrders(shopifyStore, defaultHeaders, orderApiUrl, cache, storage) {
    if (orderApiUrl == null) {
        orderApiUrl = `https://${shopifyStore}.myshopify.com/admin/api/2022-01/orders.json?limit=250`
    }

    let hasMoreOrders = true
    await storage.set('current-url', orderApiUrl)

    while (hasMoreOrders) {
        const isSnoozing = await cache.get('snoozing', null)

        if (isSnoozing) {
            continue
        }

        const orderResponse = await fetchWithRetry(orderApiUrl, defaultHeaders)
        const orderJson = await orderResponse.json()

        // if rate-limited, wait for 2 seconds for the quota to be replenished # https://shopify.dev/api/admin-rest#rate_limits
        if (orderResponse.status.toString() === '429') {
            await cache.set('snoozing', true, 2)
        }

        orderApiUrl = getNextPageUrl(orderResponse.headers)
        await storage.set('current-url', orderApiUrl)

        if (orderApiUrl === null) {
            hasMoreOrders = false
        }

        const newOrders = orderJson?.orders || []
        await capture(newOrders, storage)
    }

    await storage.set('current-url', null)
}

async function capture(orders, storage) {
    for (const order of orders) {
        const orderRecordExists = await storage.get(`shopify-order-${order.id}`)
        const customerEmail = order.customer?.email
        const customerRecordExists = await storage.get(`shopify-customer-${customerEmail}`)

        if (!orderRecordExists) {
            await storage.set(`shopify-order-${order.id}`, true)
        }

        if (!customerRecordExists) {
            await storage.set(`shopify-customer-${customerEmail}`, true)
        }

        const orderToSave = {
            order_number: order.order_number,
            currency: order.currency,
            transaction_amount: order.current_total_price,
            order_status_url: order.order_status_url,
            financial_status: order.financial_status,
            created_at: order.created_at,
        }
        
        //Only create new customers do not update them to avoid creating uncessessary events
        if (customerEmail !== undefined && !customerRecordExists) {
            // to update a user, shouldn't we send properties in $set? 
            posthog.capture('Created Shopify Customer', {
                distinct_id: order.customer.email,
                $set : {
                    ...order.customer
                }
            })
        }

        if (!orderRecordExists) {
            posthog.capture('Created Shopify Order', {
                distinct_id: customerEmail || order.id,
                ...orderToSave,
            })
        }
    }
}

async function runEveryMinute({ cache, storage, global, config }) {
    const currentUrl = await storage.get('current-url', null)
    await fetchAllOrders(config.shopifyStore, global.defaultHeaders, currentUrl, cache, storage)
}

function getNextPageUrl(headers) {
    
    if (headers?.has('link')) {
        const linkHeader = headers.get('link')
        const paginationInfo = linkHeader.split(',')

        for (let i = 0; i < paginationInfo.length; i++) {
            let paginatedLinkBody = paginationInfo[i].split(';')

            if (paginatedLinkBody[1].trim() === 'rel="next"') {
                const orderApiUrl = paginatedLinkBody[0].substring(
                    paginatedLinkBody[0].indexOf('<') + 1,
                    paginatedLinkBody[0].lastIndexOf('>')
                )
                return orderApiUrl
            }
        }
    }

    return null
}

async function fetchWithRetry(url, options = {}, method = 'GET', isRetry = false) {
    try {
        const res = await fetch(url, { method: method, ...options })
        return res
    } catch {
        if (isRetry) {
            throw new Error(`${method} request to ${url} failed.`)
        }
        const res = await fetchWithRetry(url, options, (method = method), (isRetry = true))
        return res
    }
}

function statusOk(res) {
    return String(res.status)[0] === '2'
}

module.exports = {
    setupPlugin,
    getNextPageUrl,
    runEveryMinute,
    fetchAllOrders,
}
