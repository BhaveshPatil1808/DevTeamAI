
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAX_FILE_SIZE = 200 * 1024;
const EXECUTION_TIMEOUT_MS = 5000;

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

// --------------------------------------------------
// SAFE FILE READING
// --------------------------------------------------

function safeReadFile(root, relativePath) {
    assert(
        typeof relativePath === "string" &&
        relativePath.length > 0 &&
        !path.isAbsolute(relativePath),
        "Invalid relative file path"
    );

    const parts = relativePath.split(/[\\/]/);

    assert(
        !parts.some(part =>
            !part || part === "." || part === ".."
        ),
        "Unsafe file path"
    );

    const rootReal = fs.realpathSync(root);
    let currentPath = rootReal;

    for (const part of parts) {
        currentPath = path.join(currentPath, part);

        const stat = fs.lstatSync(currentPath);

        assert(
            !stat.isSymbolicLink(),
            "Symbolic links are not allowed"
        );
    }

    const fileReal = fs.realpathSync(currentPath);
    const relative = path.relative(rootReal, fileReal);

    assert(
        relative !== "" &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative),
        "File is outside the snapshot directory"
    );

    const stat = fs.statSync(fileReal);

    assert(stat.isFile(), "Expected a regular file");
    assert(stat.size <= MAX_FILE_SIZE, "File exceeds size limit");

    return fs.readFileSync(fileReal, "utf8");
}

// --------------------------------------------------
// LOCAL STORAGE MOCK
// --------------------------------------------------

function createStorage(initialData = {}) {
    const data = { ...initialData };

    return {
        getItem(key) {
            return Object.prototype.hasOwnProperty.call(data, key)
                ? String(data[key])
                : null;
        },

        setItem(key, value) {
            data[String(key)] = String(value);
        },

        removeItem(key) {
            delete data[String(key)];
        },

        clear() {
            Object.keys(data).forEach(key => delete data[key]);
        },

        key(index) {
            return Object.keys(data)[index] ?? null;
        },

        get length() {
            return Object.keys(data).length;
        },

        snapshot() {
            return { ...data };
        }
    };
}

// --------------------------------------------------
// DOM MOCK
// --------------------------------------------------

class FakeTextNode {
    constructor(text) {
        this.nodeType = 3;
        this.textContent = String(text);
        this.parentNode = null;
    }
}

function createClassList(element) {
    function getClasses() {
        return String(element.className || "")
            .split(/\s+/)
            .filter(Boolean);
    }

    function save(classes) {
        element.className = [...new Set(classes)].join(" ");
    }

    return {
        add(...names) {
            save([...getClasses(), ...names]);
        },

        remove(...names) {
            save(getClasses().filter(name => !names.includes(name)));
        },

        contains(name) {
            return getClasses().includes(name);
        },

        toggle(name, force) {
            const exists = this.contains(name);

            if (force === true || (!exists && force !== false)) {
                this.add(name);
                return true;
            }

            if (exists) {
                this.remove(name);
            }

            return false;
        }
    };
}

function matchesSelector(element, selector) {
    selector = selector.trim();

    if (!selector) return false;

    if (selector.startsWith("#")) {
        return element.id === selector.slice(1);
    }

    if (selector.startsWith(".")) {
        return element.classList.contains(selector.slice(1));
    }

    const attributeMatch = selector.match(
        /^\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]+)["']?)?\]$/
    );

    if (attributeMatch) {
        const [, attribute, expected] = attributeMatch;

        const actual =
            element.getAttribute(attribute) ??
            element[attribute] ??
            null;

        return expected === undefined
            ? actual !== null
            : String(actual) === expected;
    }

    const tagMatch = selector.match(
        /^([a-zA-Z0-9_-]+)?(?:\.([a-zA-Z0-9_-]+))?$/
    );

    if (tagMatch) {
        const [, tag, className] = tagMatch;

        if (
            tag &&
            element.tagName.toLowerCase() !== tag.toLowerCase()
        ) {
            return false;
        }

        if (
            className &&
            !element.classList.contains(className)
        ) {
            return false;
        }

        return Boolean(tag || className);
    }

    return false;
}

class FakeElement {
    constructor(tagName) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();

        this.id = "";
        this.className = "";
        this.value = "";
        this.checked = false;
        this.disabled = false;
        this.type = "";
        this.name = "";

        this.parentNode = null;
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.style = {};

        this.listeners = {};
        this._textContent = "";
        this._innerHTML = "";

        this.classList = createClassList(this);
    }

    setAttribute(name, value) {
        value = String(value);
        this.attributes[name] = value;

        if (name === "id") this.id = value;
        if (name === "class") this.className = value;
        if (name === "value") this.value = value;
        if (name === "type") this.type = value;
        if (name === "name") this.name = value;

        if (name.startsWith("data-")) {
            const key = name
                .slice(5)
                .replace(/-([a-z])/g, (_, letter) =>
                    letter.toUpperCase()
                );

            this.dataset[key] = value;
        }
    }

    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(
            this.attributes,
            name
        )
            ? this.attributes[name]
            : null;
    }

    removeAttribute(name) {
        delete this.attributes[name];

        if (name === "id") this.id = "";
        if (name === "class") this.className = "";
    }

    appendChild(child) {
        if (child.parentNode) {
            child.parentNode.removeChild(child);
        }

        child.parentNode = this;
        this.children.push(child);

        return child;
    }

    removeChild(child) {
        const index = this.children.indexOf(child);

        if (index >= 0) {
            this.children.splice(index, 1);
            child.parentNode = null;
        }

        return child;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }

    replaceChildren(...children) {
        for (const child of [...this.children]) {
            this.removeChild(child);
        }

        for (const child of children) {
            this.appendChild(child);
        }
    }

    addEventListener(type, callback) {
        if (!this.listeners[type]) {
            this.listeners[type] = [];
        }

        this.listeners[type].push(callback);
    }

    removeEventListener(type, callback) {
        this.listeners[type] = (this.listeners[type] || [])
            .filter(listener => listener !== callback);
    }

    dispatchEvent(event) {
        event.target ??= this;
        event.currentTarget = this;
        event.defaultPrevented ??= false;

        event.preventDefault ??= function () {
            this.defaultPrevented = true;
        };

        event.stopPropagation ??= function () {
            this.cancelBubble = true;
        };

        for (const callback of this.listeners[event.type] || []) {
            callback.call(this, event);
        }

        const propertyHandler = this["on" + event.type];

        if (typeof propertyHandler === "function") {
            propertyHandler.call(this, event);
        }

        if (!event.cancelBubble && this.parentNode) {
            this.parentNode.dispatchEvent(event);
        }

        return !event.defaultPrevented;
    }

    click() {
        this.dispatchEvent({
            type: "click",
            bubbles: true
        });
    }

    querySelectorAll(selector) {
        const selectors = selector
            .split(",")
            .map(item => item.trim());

        const results = [];

        function visit(node) {
            for (const child of node.children || []) {
                if (
                    child.nodeType === 1 &&
                    selectors.some(item =>
                        matchesSelector(child, item)
                    )
                ) {
                    results.push(child);
                }

                visit(child);
            }
        }

        visit(this);

        return results;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    get textContent() {
        return this._textContent +
            this.children
                .map(child => child.textContent || "")
                .join("");
    }

    set textContent(value) {
        this._textContent = String(value ?? "");
        this.replaceChildren();
        this._innerHTML = "";
    }

    get innerText() {
        return this.textContent;
    }

    set innerText(value) {
        this.textContent = value;
    }

    get innerHTML() {
        return this._innerHTML;
    }

    set innerHTML(value) {
        this._innerHTML = String(value ?? "");
        this._textContent = "";
        this.replaceChildren();

        if (this._innerHTML.trim()) {
            parseHTML(this._innerHTML, this);
        }
    }

    get firstElementChild() {
        return this.children.find(
            child => child.nodeType === 1
        ) || null;
    }

    get lastElementChild() {
        return [...this.children]
            .reverse()
            .find(child => child.nodeType === 1) || null;
    }

    get parentElement() {
        return this.parentNode?.nodeType === 1
            ? this.parentNode
            : null;
    }
}

// --------------------------------------------------
// HTML PARSER
// --------------------------------------------------

function parseHTML(html, parent) {
    const tokens = html.match(
        /<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g
    ) || [];

    const stack = [parent];

    const voidTags = new Set([
        "area", "base", "br", "col", "embed",
        "hr", "img", "input", "link", "meta",
        "param", "source", "track", "wbr"
    ]);

    for (const token of tokens) {
        if (token.startsWith("<!--") || token.startsWith("<!")) {
            continue;
        }

        if (token.startsWith("</")) {
            const match = token.match(/^<\/([a-zA-Z0-9-]+)\s*>$/);

            if (!match) continue;

            const closingTag = match[1].toLowerCase();

            for (let i = stack.length - 1; i > 0; i--) {
                if (
                    stack[i].tagName.toLowerCase() === closingTag
                ) {
                    stack.length = i;
                    break;
                }
            }

            continue;
        }

        if (token.startsWith("<")) {
            const match = token.match(
                /^<([a-zA-Z0-9-]+)([\s\S]*?)\/?>$/
            );

            if (!match) continue;

            const tagName = match[1].toLowerCase();
            const attributes = match[2];

            const element = new FakeElement(tagName);

            const attributeRegex =
                /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

            let attributeMatch;

            while (
                (attributeMatch = attributeRegex.exec(attributes))
            ) {
                const name = attributeMatch[1];

                const value =
                    attributeMatch[2] ??
                    attributeMatch[3] ??
                    attributeMatch[4] ??
                    "";

                element.setAttribute(name, value);
            }

            stack[stack.length - 1].appendChild(element);

            if (
                !voidTags.has(tagName) &&
                !token.endsWith("/>")
            ) {
                stack.push(element);
            }

            continue;
        }

        stack[stack.length - 1].appendChild(
            new FakeTextNode(token)
        );
    }
}

// --------------------------------------------------
// DOCUMENT MOCK
// --------------------------------------------------

function createDocument(html) {
    const documentElement = new FakeElement("html");
    const body = new FakeElement("body");

    documentElement.appendChild(body);
    parseHTML(html, body);

    const listeners = {};

    return {
        documentElement,
        body,

        createElement(tagName) {
            return new FakeElement(tagName);
        },

        createTextNode(text) {
            return new FakeTextNode(text);
        },

        getElementById(id) {
            return documentElement.querySelector("#" + id);
        },

        querySelector(selector) {
            return documentElement.querySelector(selector);
        },

        querySelectorAll(selector) {
            return documentElement.querySelectorAll(selector);
        },

        addEventListener(type, callback) {
            if (!listeners[type]) {
                listeners[type] = [];
            }

            listeners[type].push(callback);
        },

        dispatchEvent(event) {
            event.target ??= this;

            for (const callback of listeners[event.type] || []) {
                callback.call(this, event);
            }
        }
    };
}

// --------------------------------------------------
// APPLICATION EXECUTION
// --------------------------------------------------

function createApplication(
    html,
    javascript,
    initialStorage = {},
    prompts = []
) {
    const document = createDocument(html);
    const localStorage = createStorage(initialStorage);

    const promptQueue = [...prompts];
    const windowListeners = [];

    const window = {
        document,
        localStorage,

        addEventListener(type, callback) {
            windowListeners.push({ type, callback });
        },

        dispatchEvent(event) {
            for (const listener of windowListeners) {
                if (listener.type === event.type) {
                    listener.callback.call(window, event);
                }
            }
        }
    };

    const sandbox = {
        document,
        window,
        localStorage,

        crypto: {
            getRandomValues(array) {
                for (let i = 0; i < array.length; i++) {
                    array[i] = Math.floor(Math.random() * 256);
                }

                return array;
            }
        },

        console: {
            log() {},
            warn() {},
            error() {}
        },

        alert() {},
        confirm() {
            return true;
        },

        prompt() {
            return promptQueue.length
                ? promptQueue.shift()
                : null;
        },

        Math,
        Date,
        JSON,
        String,
        Number,
        Boolean,
        Array,
        Object,
        RegExp,
        Error,
        Map,
        Set,
        Promise,
        Uint8Array,
        parseInt,
        parseFloat,
        isNaN
    };

    const context = vm.createContext(sandbox, {
        codeGeneration: {
            strings: false,
            wasm: false
        }
    });

    // IMPORTANT:
    // Only expose declarations explicitly marked with "export".
    // Local declarations such as "const raw" must never be exposed.

    const exportedNames = [];

    const exportDeclarationRegex =
        /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;

    let match;

    while (
        (match = exportDeclarationRegex.exec(javascript))
    ) {
        exportedNames.push(match[1]);
    }

    const exportListRegex =
        /\bexport\s*\{\s*([^}]+)\s*\}\s*;?/g;

    while (
        (match = exportListRegex.exec(javascript))
    ) {
        const names = match[1]
            .split(",")
            .map(item =>
                item.trim().split(/\s+as\s+/)[0]
            )
            .filter(Boolean);

        exportedNames.push(...names);
    }

    const uniqueNames = [...new Set(exportedNames)];

    // Remove ES module export syntax for VM execution.
    let source = javascript.replace(
        /\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/g,
        ""
    );

    source = source.replace(
        /\bexport\s*\{[^}]+\}\s*;?/g,
        ""
    );

    // Expose only genuine exports.
    const exportObject = uniqueNames
        .map(name =>
            JSON.stringify(name) + ": " + name
        )
        .join(", ");

    source +=
        "\nglobalThis.__testExports = {" +
        exportObject +
        "};";

    const script = new vm.Script(source, {
        filename: "app.js"
    });

    script.runInContext(context, {
        timeout: EXECUTION_TIMEOUT_MS
    });

    document.dispatchEvent({
        type: "DOMContentLoaded"
    });

    window.dispatchEvent({
        type: "load"
    });

    return {
        document,
        localStorage,
        exports: context.__testExports || {}
    };
}

// --------------------------------------------------
// TEST HELPERS
// --------------------------------------------------

function readTasks(app) {
    const raw = app.localStorage.getItem("todoTasks");

    if (!raw) return [];

    const tasks = JSON.parse(raw);

    assert(
        Array.isArray(tasks),
        "Stored tasks must be an array"
    );

    return tasks;
}

function findTaskElement(app, task) {
    const elements = app.document.querySelectorAll(
        "li.task-item"
    );

    return elements.find(element =>
        String(element.dataset.id) === String(task.id)
    ) || null;
}

function findButton(root, keyword) {
    if (!root) return null;

    return root.querySelectorAll("button").find(button =>
        button.textContent.trim().toLowerCase() ===
        keyword.toLowerCase()
    ) || null;
}

function runTest(results, name, callback) {
    try {
        callback();

        results.push({
            name,
            status: "passed"
        });
    } catch (error) {
        results.push({
            name,
            status: "failed",
            error: error.message,
            stack: error.stack || null
        });
    }
}

// --------------------------------------------------
// TODO APPLICATION TESTS
// --------------------------------------------------

function runTodoTests(snapshotRoot, htmlPath, jsPath) {
    const html = safeReadFile(snapshotRoot, htmlPath);
    const javascript = safeReadFile(snapshotRoot, jsPath);

    const results = [];

    const requiredIds = [
        "task-form",
        "task-title",
        "task-desc",
        "task-list"
    ];

    runTest(results, "HTML contains required elements", () => {
        for (const id of requiredIds) {
            assert(
                new RegExp(
                    "\\bid=[\"']" + id + "[\"']",
                    "i"
                ).test(html),
                "Missing HTML element: " + id
            );
        }
    });

    runTest(results, "HTML references application JavaScript", () => {
        assert(
            html.includes(jsPath.replace(/\\/g, "/")),
            "HTML does not reference " + jsPath
        );
    });

    let app = null;

    runTest(results, "Application initializes", () => {
        app = createApplication(html, javascript);

        for (const id of requiredIds) {
            assert(
                app.document.getElementById(id),
                "Missing application element: " + id
            );
        }

        const requiredFunctions = [
            "getAllTasks",
            "addTask",
            "updateTask",
            "deleteTask",
            "toggleTaskCompletion"
        ];

        for (const name of requiredFunctions) {
            assert(
                typeof app.exports[name] === "function",
                "Missing exported function: " + name
            );
        }
    });

    if (!app) {
        return createReport(results);
    }

    runTest(results, "Application starts with an empty task list", () => {
        assert(
            readTasks(app).length === 0,
            "Expected an empty task list"
        );
    });

    runTest(results, "Empty task submission is rejected", () => {
        const form = app.document.getElementById("task-form");
        const title = app.document.getElementById("task-title");
        const description = app.document.getElementById("task-desc");

        title.value = "";
        description.value = "";

        form.dispatchEvent({
            type: "submit",
            bubbles: true
        });

        assert(
            readTasks(app).length === 0,
            "An empty task was created"
        );
    });

    runTest(results, "Task creation works", () => {
        const form = app.document.getElementById("task-form");
        const title = app.document.getElementById("task-title");
        const description = app.document.getElementById("task-desc");

        title.value = "Functional test task";
        description.value = "Created by DevTeamAI";

        form.dispatchEvent({
            type: "submit",
            bubbles: true
        });

        const tasks = readTasks(app);

        assert(
            tasks.length === 1,
            "Expected exactly one task"
        );

        assert(
            tasks[0].title === "Functional test task",
            "Task title was not saved correctly"
        );

        assert(
            tasks[0].description === "Created by DevTeamAI",
            "Task description was not saved correctly"
        );
    });

    runTest(results, "Task survives application reload", () => {
        const savedStorage = app.localStorage.snapshot();

        const reloadedApp = createApplication(
            html,
            javascript,
            savedStorage
        );

        const tasks = readTasks(reloadedApp);

        assert(
            tasks.length === 1,
            "Task was lost after reload"
        );

        assert(
            tasks[0].title === "Functional test task",
            "Task title changed after reload"
        );
    });

    runTest(results, "Task editing works", () => {
        const task = readTasks(app)[0];

        assert(task, "No task available to edit");

        const taskElement = findTaskElement(app, task);

        assert(taskElement, "Task element not found");

        const editButton = findButton(taskElement, "Edit");

        assert(editButton, "Edit button not found");

        const editedApp = createApplication(
            html,
            javascript,
            app.localStorage.snapshot(),
            [
                "Updated functional test task",
                "Updated description"
            ]
        );

        const editedTask = readTasks(editedApp)[0];
        const editedElement = findTaskElement(editedApp, editedTask);

        const editedButton = findButton(editedElement, "Edit");

        assert(editedButton, "Edit button not found after reload");

        editedButton.click();

        const tasks = readTasks(editedApp);

        assert(
            tasks[0].title === "Updated functional test task",
            "Task title was not updated"
        );

        assert(
            tasks[0].description === "Updated description",
            "Task description was not updated"
        );

        app = editedApp;
    });

    runTest(results, "Task completion works", () => {
        const task = readTasks(app)[0];

        assert(task, "No task available to complete");

        const taskElement = findTaskElement(app, task);

        assert(taskElement, "Task element not found");

        const checkbox = taskElement
            .querySelectorAll("input")
            .find(input => input.type === "checkbox");

        assert(checkbox, "Completion checkbox not found");

        checkbox.checked = true;

        checkbox.dispatchEvent({
            type: "change",
            bubbles: true
        });

        const updatedTask = readTasks(app)[0];

        assert(
            updatedTask.completed === true,
            "Task was not marked as completed"
        );
    });

    runTest(results, "Task deletion works", () => {
        const task = readTasks(app)[0];

        assert(task, "No task available to delete");

        const taskElement = findTaskElement(app, task);

        assert(taskElement, "Task element not found");

        const deleteButton = findButton(taskElement, "Delete");

        assert(deleteButton, "Delete button not found");

        deleteButton.click();

        assert(
            readTasks(app).length === 0,
            "Task was not deleted"
        );
    });

    runTest(results, "Corrupt localStorage is recovered", () => {
        const corruptStorage = {
            todoTasks: "{invalid-json"
        };

        const recoveredApp = createApplication(
            html,
            javascript,
            corruptStorage
        );

        const raw = recoveredApp.localStorage.getItem("todoTasks");

        assert(
            raw === null || Array.isArray(JSON.parse(raw)),
            "Application did not recover from corrupted storage"
        );
    });

    return createReport(results);
}

// --------------------------------------------------
// REPORT
// --------------------------------------------------

function createReport(results) {
    const passed = results.filter(
        item => item.status === "passed"
    ).length;

    const failed = results.filter(
        item => item.status === "failed"
    ).length;

    return {
        mode: "simulated-dom",
        status: failed === 0 ? "passed" : "failed",

        tests: results,

        summary: {
            total: results.length,
            passed,
            failed
        },

        visualBrowserTesting: "not_run"
    };
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

function main() {
    const snapshotRoot = process.argv[2];
    const htmlPath = process.argv[3];
    const jsPath = process.argv[4];

    assert(snapshotRoot, "Snapshot directory is required");
    assert(htmlPath, "HTML file path is required");
    assert(jsPath, "JavaScript file path is required");

    const root = fs.realpathSync(snapshotRoot);

    const report = runTodoTests(
        root,
        htmlPath,
        jsPath
    );

    process.stdout.write(
        JSON.stringify(report, null, 2) + "\n"
    );

    if (report.status !== "passed") {
        process.exitCode = 1;
    }
}

try {
    main();
} catch (error) {
    process.stderr.write(
        JSON.stringify({
            status: "error",
            error: error.message,
            stack: error.stack || null
        }, null, 2) + "\n"
    );

    process.exitCode = 1;
}
