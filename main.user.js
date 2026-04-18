// ==UserScript==
// @name         请求拦截器-稳定队列版
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  健壮队列，阶段分离，自动破解VIP，手动修改请求/响应
// @author       Stable Queue
// @match        https://*.nobook.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ---------- 配置 ----------
    const MAX_QUEUE_SIZE = 50; // 防止无限堆积（可选）

    // ---------- 状态 ----------
    let enabled = true;
    let queue = [];
    let processing = false;
    let current = null;               // 当前正在处理的项
    let processingLock = false;       // 防止 processNext 重入

    // UI 元素
    let panel, contentDiv, statusSpan, queueSpan, stageSpan, urlDiv, methodDiv, reqEditor, respEditor, logDiv;
    let isCollapsed = false;

    // 日志
    const logs = [];
    function addLog(msg, type = 'info') {
        const time = new Date().toLocaleTimeString();
        const prefix = type === 'modify' ? '[修改]' : (type === 'error' ? '[错误]' : '[信息]');
        const full = `[${time}] ${prefix} ${msg}`;
        logs.push(full);
        if (logs.length > 100) logs.shift();
        if (logDiv) {
            try { logDiv.value = logs.join('\n'); } catch(e) {}
            logDiv.scrollTop = logDiv.scrollHeight;
        }
        console[type === 'error' ? 'error' : 'log'](`[拦截器] ${full}`);
    }

    // ---------- 自动修改规则 ----------
    function autoUnlock(data, path = 'root') {
        if (!data || typeof data !== 'object') return data;
        let modified = false;
        const modify = (obj, key, newVal, oldVal) => {
            obj[key] = newVal;
            modified = true;
            addLog(`自动修改 ${path}.${key}: ${oldVal} → ${newVal}`, 'modify');
        };
        if (Array.isArray(data)) {
            for (let i = 0; i < data.length; i++) {
                data[i] = autoUnlock(data[i], `${path}[${i}]`);
            }
            return data;
        }
        for (let key in data) {
            if (!data.hasOwnProperty(key)) continue;
            const lower = key.toLowerCase();
            const val = data[key];
            if (typeof val === 'boolean') {
                if (/(vip|lock|hidden|hide|disabled|premium|onlyvip|needvip)/.test(lower) && val !== false) {
                    modify(data, key, false, val);
                } else if (/(free|unlock|visible|show|enable|active|canuse)/.test(lower) && val !== true) {
                    modify(data, key, true, val);
                }
            }
            if (typeof val === 'number') {
                if (/(price|cost|coin|point|vipscore|credit)/.test(lower) && val > 0) {
                    modify(data, key, 0, val);
                }
            }
            if (data[key] && typeof data[key] === 'object') {
                data[key] = autoUnlock(data[key], `${path}.${key}`);
            }
        }
        return data;
    }

    function isEquipmentLike(data) {
        if (!data || typeof data !== 'object') return false;
        try {
            return /(vip|lock|price|equipment|tool)/.test(JSON.stringify(data).toLowerCase());
        } catch(e) { return false; }
    }

    // ---------- 创建面板（极简）----------
    function createPanel() {
        if (panel) return;
        panel = document.createElement('div');
        panel.id = 'interceptor-panel';
        panel.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:#fff;border:1px solid #000;font-family:monospace;font-size:12px;width:480px;';

        const title = document.createElement('div');
        title.style.cssText = 'background:#ddd;padding:4px 6px;border-bottom:1px solid #000;cursor:pointer;';
        title.innerHTML = '<span style="font-weight:bold;">🚦 请求拦截器 (稳定版)</span> <button id="toggle-panel" style="float:right;border:1px solid #000;background:#eee;padding:0 4px;">−</button>';
        panel.appendChild(title);

        contentDiv = document.createElement('div');
        contentDiv.style.cssText = 'padding:5px;';

        // 状态行
        const statusLine = document.createElement('div');
        statusSpan = document.createElement('span');
        queueSpan = document.createElement('span');
        stageSpan = document.createElement('span');
        stageSpan.style.marginLeft = '10px';
        statusLine.innerHTML = '状态: ';
        statusLine.appendChild(statusSpan);
        statusLine.appendChild(document.createTextNode(' 队列: '));
        statusLine.appendChild(queueSpan);
        statusLine.appendChild(stageSpan);
        contentDiv.appendChild(statusLine);

        // 控制按钮
        const btnLine = document.createElement('div');
        btnLine.style.margin = '4px 0';
        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = '暂停拦截';
        toggleBtn.style.cssText = 'border:1px solid #000;background:#eee;padding:2px 6px;margin-right:4px;';
        toggleBtn.onclick = () => {
            enabled = !enabled;
            toggleBtn.textContent = enabled ? '暂停拦截' : '启用拦截';
            statusSpan.textContent = enabled ? '🟢 拦截中' : '⏸️ 已暂停';
            addLog(enabled ? '拦截已启用' : '拦截已暂停');
            if (enabled && !processing) processNext();
        };
        const clearQueueBtn = document.createElement('button');
        clearQueueBtn.textContent = '清空队列';
        clearQueueBtn.style.cssText = 'border:1px solid #000;background:#eee;padding:2px 6px;';
        clearQueueBtn.onclick = () => {
            const count = queue.length;
            queue = [];
            updateQueueDisplay();
            addLog(`已清空 ${count} 个待处理请求`);
        };
        btnLine.appendChild(toggleBtn);
        btnLine.appendChild(clearQueueBtn);
        contentDiv.appendChild(btnLine);

        methodDiv = document.createElement('div');
        urlDiv = document.createElement('div');
        urlDiv.style.cssText = 'margin:2px 0;word-break:break-all;';
        contentDiv.appendChild(methodDiv);
        contentDiv.appendChild(urlDiv);

        contentDiv.appendChild(document.createTextNode('📤 请求体 (可编辑):'));
        reqEditor = document.createElement('textarea');
        reqEditor.style.cssText = 'width:100%;height:70px;margin:2px 0;border:1px solid #000;font-family:monospace;font-size:11px;';
        contentDiv.appendChild(reqEditor);

        contentDiv.appendChild(document.createTextNode('📥 响应体 (可编辑):'));
        respEditor = document.createElement('textarea');
        respEditor.style.cssText = 'width:100%;height:120px;margin:2px 0;border:1px solid #000;font-family:monospace;font-size:11px;';
        contentDiv.appendChild(respEditor);

        // 操作按钮
        const actionLine = document.createElement('div');
        actionLine.style.margin = '4px 0';
        const passBtn = document.createElement('button');
        passBtn.textContent = '放行';
        passBtn.style.cssText = 'border:1px solid #000;background:#eee;padding:2px 8px;margin-right:4px;';
        passBtn.onclick = () => resolveCurrent('pass');
        const dropBtn = document.createElement('button');
        dropBtn.textContent = '舍弃';
        dropBtn.style.cssText = 'border:1px solid #000;background:#eee;padding:2px 8px;margin-right:4px;';
        dropBtn.onclick = () => resolveCurrent('drop');
        const skipBtn = document.createElement('button');
        skipBtn.textContent = '跳过';
        skipBtn.style.cssText = 'border:1px solid #000;background:#eee;padding:2px 8px;';
        skipBtn.onclick = () => {
            if (current) {
                try {
                    const { resolve, request, stage } = current;
                    resolve(stage === 'request' ? undefined : (request.responseText || ''));
                    addLog('已跳过当前拦截');
                } catch(e) {
                    addLog(`跳过时出错: ${e.message}`, 'error');
                } finally {
                    current = null;
                    processing = false;
                    processNext();
                }
            }
        };
        actionLine.appendChild(passBtn);
        actionLine.appendChild(dropBtn);
        actionLine.appendChild(skipBtn);
        contentDiv.appendChild(actionLine);

        logDiv = document.createElement('textarea');
        logDiv.readOnly = true;
        logDiv.style.cssText = 'width:100%;height:100px;margin-top:5px;border:1px solid #000;font-size:10px;';
        contentDiv.appendChild(logDiv);

        panel.appendChild(contentDiv);
        document.body.appendChild(panel);

        const togglePanelBtn = document.getElementById('toggle-panel');
        togglePanelBtn.onclick = (e) => {
            e.stopPropagation();
            isCollapsed = !isCollapsed;
            contentDiv.style.display = isCollapsed ? 'none' : 'block';
            togglePanelBtn.textContent = isCollapsed ? '+' : '−';
            panel.style.width = isCollapsed ? 'auto' : '480px';
        };
        title.onclick = () => togglePanelBtn.click();

        statusSpan.textContent = '🟢 拦截中';
        queueSpan.textContent = '0';
        stageSpan.textContent = '';
    }

    function waitForBody() {
        if (document.body) createPanel();
        else setTimeout(waitForBody, 30);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForBody);
    else waitForBody();

    // ---------- 队列管理（加固）----------
    function processNext() {
        // 防止重入
        if (processingLock) return;
        processingLock = true;

        try {
            // 清理无效状态
            if (!enabled) {
                processing = false;
                current = null;
                updateQueueDisplay();
                return;
            }

            if (processing || queue.length === 0) {
                processing = false;
                current = null;
                updateQueueDisplay();
                return;
            }

            // 取出下一个
            const next = queue.shift();
            if (!next) {
                processing = false;
                current = null;
                updateQueueDisplay();
                return;
            }

            current = next;
            processing = true;
            displayRequest(current);
        } catch (e) {
            addLog(`队列处理异常: ${e.message}`, 'error');
            current = null;
            processing = false;
        } finally {
            processingLock = false;
            updateQueueDisplay();
        }
    }

    function updateQueueDisplay() {
        if (queueSpan) queueSpan.textContent = queue.length;
    }

    function displayRequest(item) {
        try {
            const { request, stage } = item;
            if (!methodDiv || !urlDiv) return;

            methodDiv.textContent = `方法: ${request.method}`;
            urlDiv.textContent = `URL: ${request.url}`;

            stageSpan.textContent = stage === 'request' ? ' | 📤 拦截请求' : ' | 📥 拦截响应';
            stageSpan.style.color = stage === 'request' ? '#2980b9' : '#27ae60';

            if (stage === 'request') {
                if (request.body) {
                    try {
                        reqEditor.value = JSON.stringify(JSON.parse(request.body), null, 2);
                    } catch {
                        reqEditor.value = request.body;
                    }
                } else {
                    reqEditor.value = '';
                }
                respEditor.value = '';
            } else {
                if (!reqEditor.value) reqEditor.value = '';
                if (request.responseText) {
                    try {
                        respEditor.value = JSON.stringify(JSON.parse(request.responseText), null, 2);
                    } catch {
                        respEditor.value = request.responseText;
                    }
                } else {
                    respEditor.value = '';
                }
            }

            reqEditor.style.background = stage === 'request' ? '#fef9e7' : '#fff';
            respEditor.style.background = stage === 'response' ? '#eafaf1' : '#fff';
        } catch (e) {
            addLog(`显示请求异常: ${e.message}`, 'error');
        }
    }

    function resolveCurrent(action) {
        if (!current) {
            addLog('没有待处理的请求', 'error');
            return;
        }

        const { resolve, reject, request, stage } = current;
        try {
            if (action === 'drop') {
                reject(new Error('用户舍弃'));
                addLog(`舍弃${stage === 'request' ? '请求' : '响应'}: ${request.url}`);
            } else {
                if (stage === 'request') {
                    if (reqEditor.value && reqEditor.value !== request.body) {
                        request.modifiedBody = reqEditor.value;
                        addLog(`请求体已手动修改`, 'modify');
                    }
                    resolve(); // 继续发送请求
                } else {
                    let finalResp = respEditor.value;
                    // 自动修改
                    if (request.responseText) {
                        try {
                            const data = JSON.parse(request.responseText);
                            if (isEquipmentLike(data)) {
                                const unlocked = autoUnlock(JSON.parse(JSON.stringify(data)));
                                const newResp = JSON.stringify(unlocked);
                                if (newResp !== request.responseText) {
                                    finalResp = newResp;
                                    addLog(`响应体已自动应用VIP破解`, 'modify');
                                    respEditor.value = newResp;
                                }
                            }
                        } catch (e) {
                            addLog(`自动修改解析失败: ${e.message}`, 'error');
                        }
                    }
                    resolve(finalResp || request.responseText);
                    addLog(`放行响应: ${request.url}`);
                }
            }
        } catch (e) {
            addLog(`处理操作时异常: ${e.message}`, 'error');
            // 尝试优雅降级：如果是请求阶段就 resolve，响应阶段就用原始响应
            if (stage === 'request') {
                try { resolve(); } catch (_) {}
            } else {
                try { resolve(request.responseText); } catch (_) {}
            }
        } finally {
            current = null;
            processing = false;
            // 延迟一点再处理下一个，避免栈溢出
            setTimeout(() => processNext(), 10);
        }
    }

    // 安全入队函数
    function safeEnqueue(item) {
        if (!enabled) {
            // 如果拦截已禁用，直接 resolve/reject 以继续流程
            if (item.stage === 'request') item.resolve();
            else item.resolve(item.request.responseText);
            return;
        }
        if (queue.length >= MAX_QUEUE_SIZE) {
            addLog(`队列已满(${MAX_QUEUE_SIZE})，强制放行当前请求`, 'error');
            if (item.stage === 'request') item.resolve();
            else item.resolve(item.request.responseText);
            return;
        }
        queue.push(item);
        updateQueueDisplay();
        if (!processing) processNext();
    }

    // ---------- 拦截 fetch ----------
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : input.url;
        const method = (init && init.method) || 'GET';
        const body = init && init.body;

        if (!enabled) return originalFetch.call(this, input, init);

        addLog(`fetch请求: ${method} ${url}`);

        // 请求阶段
        await new Promise((resolve, reject) => {
            safeEnqueue({
                resolve, reject,
                request: { type: 'fetch', url, method, body },
                stage: 'request'
            });
        }).catch(() => { throw new Error('请求被用户舍弃'); });

        // 实际发送
        let resp;
        try {
            resp = await originalFetch.call(this, input, init);
        } catch (e) {
            // 如果请求被舍弃或其他错误，直接抛出
            throw e;
        }

        const clone = resp.clone();
        const text = await clone.text();

        // 响应阶段
        const modifiedText = await new Promise((resolve, reject) => {
            safeEnqueue({
                resolve, reject,
                request: {
                    type: 'fetch',
                    url, method,
                    responseText: text,
                    status: resp.status,
                    statusText: resp.statusText,
                    headers: resp.headers,
                    originalResponse: resp
                },
                stage: 'response'
            });
        });

        if (modifiedText && modifiedText !== text) {
            return new Response(modifiedText, {
                status: resp.status,
                statusText: resp.statusText,
                headers: resp.headers
            });
        }
        return resp;
    };

    // ---------- 拦截 XHR ----------
    const XHR = unsafeWindow.XMLHttpRequest;
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function(method, url, ...rest) {
        this._method = method;
        this._url = url;
        return originalOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function(...args) {
        const self = this;
        const body = args[0];
        const method = self._method;
        const url = self._url;

        if (!enabled) return originalSend.call(this, ...args);

        addLog(`XHR请求: ${method} ${url}`);

        // 请求阶段拦截
        new Promise((resolve, reject) => {
            safeEnqueue({
                resolve, reject,
                request: { type: 'xhr', url, method, body },
                stage: 'request'
            });
        }).then(() => {
            originalSend.call(self, ...args);
        }).catch(() => {
            if (self.onerror) self.onerror(new Error('请求被用户舍弃'));
            self.dispatchEvent(new Event('error'));
        });

        // 响应阶段拦截
        self.addEventListener('readystatechange', function() {
            if (self.readyState === 4) {
                const responseText = self.responseText;
                new Promise((resolve, reject) => {
                    safeEnqueue({
                        resolve: (finalResp) => {
                            if (finalResp && finalResp !== responseText) {
                                Object.defineProperty(self, 'responseText', { value: finalResp, configurable: true });
                                Object.defineProperty(self, 'response', { value: finalResp, configurable: true });
                            }
                            if (self.onload) self.onload();
                            if (self.onreadystatechange) self.onreadystatechange.call(self);
                        },
                        reject: (err) => {
                            if (self.onerror) self.onerror(err);
                            self.dispatchEvent(new Event('error'));
                        },
                        request: {
                            type: 'xhr',
                            url, method,
                            responseText,
                            status: self.status,
                            statusText: self.statusText,
                            headers: self.getAllResponseHeaders()
                        },
                        stage: 'response'
                    });
                });
            }
        });
    };

    addLog('拦截器已启动 (稳定队列版)');
})();
