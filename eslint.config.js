// Lint config for the userscript.
//
// `no-undef` is the rule that earns its keep here: `node --check` validates syntax and will
// happily pass a reference to a variable that does not exist in scope. That shipped once —
// a refactor moved the request into its own function and left `token` behind in the caller,
// which only surfaced as a ReferenceError in the browser.
export default [
    {
        files: ['*.user.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                window: 'readonly',
                document: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                Promise: 'readonly',
                DOMParser: 'readonly',
                CSS: 'readonly',
                XMLHttpRequest: 'writable',
                fetch: 'writable',
                GM_xmlhttpRequest: 'readonly',
                GM_setValue: 'readonly',
                GM_getValue: 'readonly',
                GM_registerMenuCommand: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            // `caughtErrors: none` because several catches deliberately swallow — a failure
            // in our hook must never break Torn's own handler. `ignoreRestSiblings` because
            // stripLocalKeys uses the destructuring-omit idiom to drop the underscore keys.
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
        },
    },
];
