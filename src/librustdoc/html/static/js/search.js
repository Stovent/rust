/* eslint-env es6 */
/* eslint no-var: "error" */
/* eslint prefer-const: "error" */
/* eslint prefer-arrow-callback: "error" */
/* global addClass, getNakedUrl, getSettingValue, hasOwnPropertyRustdoc, initSearch, onEach */
/* global onEachLazy, removeClass, searchState, browserSupportsHistoryApi */

(function () {
// This mapping table should match the discriminants of
// `rustdoc::formats::item_type::ItemType` type in Rust.
const itemTypes = [
    "mod",
    "externcrate",
    "import",
    "struct",
    "enum",
    "fn",
    "type",
    "static",
    "trait",
    "impl",
    "tymethod",
    "method",
    "structfield",
    "variant",
    "macro",
    "primitive",
    "associatedtype",
    "constant",
    "associatedconstant",
    "union",
    "foreigntype",
    "keyword",
    "existential",
    "attr",
    "derive",
    "traitalias",
];

// used for special search precedence
const TY_PRIMITIVE = itemTypes.indexOf("primitive");
const TY_KEYWORD = itemTypes.indexOf("keyword");

// In the search display, allows to switch between tabs.
function printTab(nb) {
    if (nb === 0 || nb === 1 || nb === 2) {
        searchState.currentTab = nb;
    }
    let nb_copy = nb;
    onEachLazy(document.getElementById("titles").childNodes, elem => {
        if (nb_copy === 0) {
            addClass(elem, "selected");
        } else {
            removeClass(elem, "selected");
        }
        nb_copy -= 1;
    });
    onEachLazy(document.getElementById("results").childNodes, elem => {
        if (nb === 0) {
            addClass(elem, "active");
        } else {
            removeClass(elem, "active");
        }
        nb -= 1;
    });
}

/**
 * A function to compute the Levenshtein distance between two strings
 * Licensed under the Creative Commons Attribution-ShareAlike 3.0 Unported
 * Full License can be found at http://creativecommons.org/licenses/by-sa/3.0/legalcode
 * This code is an unmodified version of the code written by Marco de Wit
 * and was found at https://stackoverflow.com/a/18514751/745719
 */
const levenshtein_row2 = [];
function levenshtein(s1, s2) {
    if (s1 === s2) {
        return 0;
    }
    const s1_len = s1.length, s2_len = s2.length;
    if (s1_len && s2_len) {
        let i1 = 0, i2 = 0, a, b, c, c2;
        const row = levenshtein_row2;
        while (i1 < s1_len) {
            row[i1] = ++i1;
        }
        while (i2 < s2_len) {
            c2 = s2.charCodeAt(i2);
            a = i2;
            ++i2;
            b = i2;
            for (i1 = 0; i1 < s1_len; ++i1) {
                c = a + (s1.charCodeAt(i1) !== c2 ? 1 : 0);
                a = row[i1];
                b = b < a ? (b < c ? b + 1 : c) : (a < c ? a + 1 : c);
                row[i1] = b;
            }
        }
        return b;
    }
    return s1_len + s2_len;
}

window.initSearch = rawSearchIndex => {
    const MAX_LEV_DISTANCE = 3;
    const MAX_RESULTS = 200;
    const GENERICS_DATA = 2;
    const NAME = 0;
    const INPUTS_DATA = 0;
    const OUTPUT_DATA = 1;
    const NO_TYPE_FILTER = -1;
    /**
     *  @type {Array<Row>}
     */
    let searchIndex;
    let currentResults;
    const ALIASES = {};
    const params = searchState.getQueryStringParams();

    // Populate search bar with query string search term when provided,
    // but only if the input bar is empty. This avoid the obnoxious issue
    // where you start trying to do a search, and the index loads, and
    // suddenly your search is gone!
    if (searchState.input.value === "") {
        searchState.input.value = params.search || "";
    }

    function isWhitespace(c) {
        return " \t\n\r".indexOf(c) !== -1;
    }

    function isSpecialStartCharacter(c) {
        return "<\"".indexOf(c) !== -1;
    }

    function isEndCharacter(c) {
        return ",>-".indexOf(c) !== -1;
    }

    function isStopCharacter(c) {
        return isWhitespace(c) || isEndCharacter(c);
    }

    function isErrorCharacter(c) {
        return "()".indexOf(c) !== -1;
    }

    function itemTypeFromName(typename) {
        for (let i = 0, len = itemTypes.length; i < len; ++i) {
            if (itemTypes[i] === typename) {
                return i;
            }
        }

        throw new Error("Unknown type filter `" + typename + "`");
    }

    /**
     * If we encounter a `"`, then we try to extract the string from it until we find another `"`.
     *
     * This function will throw an error in the following cases:
     * * There is already another string element.
     * * We are parsing a generic argument.
     * * There is more than one element.
     * * There is no closing `"`.
     *
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     * @param {boolean} isInGenerics
     */
    function getStringElem(query, parserState, isInGenerics) {
        if (isInGenerics) {
            throw new Error("`\"` cannot be used in generics");
        } else if (query.literalSearch) {
            throw new Error("Cannot have more than one literal search element");
        } else if (parserState.totalElems - parserState.genericsElems > 0) {
            throw new Error("Cannot use literal search when there is more than one element");
        }
        parserState.pos += 1;
        const start = parserState.pos;
        const end = getIdentEndPosition(parserState);
        if (parserState.pos >= parserState.length) {
            throw new Error("Unclosed `\"`");
        } else if (parserState.userQuery[end] !== "\"") {
            throw new Error(`Unexpected \`${parserState.userQuery[end]}\` in a string element`);
        } else if (start === end) {
            throw new Error("Cannot have empty string element");
        }
        // To skip the quote at the end.
        parserState.pos += 1;
        query.literalSearch = true;
    }

    /**
     * Returns `true` if the current parser position is starting with "::".
     *
     * @param {ParserState} parserState
     *
     * @return {boolean}
     */
    function isPathStart(parserState) {
        return parserState.userQuery.slice(parserState.pos, parserState.pos + 2) == '::';
    }

    /**
     * Returns `true` if the current parser position is starting with "->".
     *
     * @param {ParserState} parserState
     *
     * @return {boolean}
     */
    function isReturnArrow(parserState) {
        return parserState.userQuery.slice(parserState.pos, parserState.pos + 2) == '->';
    }

    /**
     * Returns `true` if the given `c` character is valid for an ident.
     *
     * @param {string} c
     *
     * @return {boolean}
     */
    function isIdentCharacter(c) {
        return (
            c === '_' ||
            (c >= '0' && c <= '9') ||
            (c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z'));
    }

    /**
     * Returns `true` if the given `c` character is a separator.
     *
     * @param {string} c
     *
     * @return {boolean}
     */
    function isSeparatorCharacter(c) {
        return c === "," || isWhitespaceCharacter(c);
    }

    /**
     * Returns `true` if the given `c` character is a whitespace.
     *
     * @param {string} c
     *
     * @return {boolean}
     */
    function isWhitespaceCharacter(c) {
        return c === " " || c === "\t";
    }

    /**
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     * @param {string} name                  - Name of the query element.
     * @param {Array<QueryElement>} generics - List of generics of this query element.
     *
     * @return {QueryElement}                - The newly created `QueryElement`.
     */
    function createQueryElement(query, parserState, name, generics, isInGenerics) {
        if (name === '*' || (name.length === 0 && generics.length === 0)) {
            return;
        }
        if (query.literalSearch && parserState.totalElems - parserState.genericsElems > 0) {
            throw new Error("You cannot have more than one element if you use quotes");
        }
        const pathSegments = name.split("::");
        if (pathSegments.length > 1) {
            for (let i = 0, len = pathSegments.length; i < len; ++i) {
                const pathSegment = pathSegments[i];

                if (pathSegment.length === 0) {
                    if (i === 0) {
                        throw new Error("Paths cannot start with `::`");
                    } else if (i + 1 === len) {
                        throw new Error("Paths cannot end with `::`");
                    }
                    throw new Error("Unexpected `::::`");
                }
            }
        }
        // In case we only have something like `<p>`, there is no name.
        if (pathSegments.length === 0 || (pathSegments.length === 1 && pathSegments[0] === "")) {
            throw new Error("Found generics without a path");
        }
        parserState.totalElems += 1;
        if (isInGenerics) {
            parserState.genericsElems += 1;
        }
        return {
            name: name,
            fullPath: pathSegments,
            pathWithoutLast: pathSegments.slice(0, pathSegments.length - 1),
            pathLast: pathSegments[pathSegments.length - 1],
            generics: generics,
        };
    }

    /**
     * This function goes through all characters until it reaches an invalid ident character or the
     * end of the query. It returns the position of the last character of the ident.
     *
     * @param {ParserState} parserState
     *
     * @return {integer}
     */
    function getIdentEndPosition(parserState) {
        let end = parserState.pos;
        let foundExclamation = false;
        while (parserState.pos < parserState.length) {
            const c = parserState.userQuery[parserState.pos];
            if (!isIdentCharacter(c)) {
                if (c === "!") {
                    if (foundExclamation) {
                        throw new Error("Cannot have more than one `!` in an ident");
                    } else if (parserState.pos + 1 < parserState.length &&
                        isIdentCharacter(parserState.userQuery[parserState.pos + 1]))
                    {
                        throw new Error("`!` can only be at the end of an ident");
                    }
                    foundExclamation = true;
                } else if (isErrorCharacter(c)) {
                    throw new Error(`Unexpected \`${c}\``);
                } else if (
                    isStopCharacter(c) ||
                    isSpecialStartCharacter(c) ||
                    isSeparatorCharacter(c))
                {
                    break;
                }
                // If we allow paths ("str::string" for example).
                else if (c === ":") {
                    if (!isPathStart(parserState)) {
                        break;
                    }
                    // Skip current ":".
                    parserState.pos += 1;
                    foundExclamation = false;
                } else {
                    throw new Error(`Unexpected \`${c}\``);
                }
            }
            parserState.pos += 1;
            end = parserState.pos;
        }
        return end;
    }

    /**
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     * @param {Array<QueryElement>} elems - This is where the new {QueryElement} will be added.
     * @param {boolean} isInGenerics
     */
    function getNextElem(query, parserState, elems, isInGenerics) {
        const generics = [];

        let start = parserState.pos;
        let end;
        // We handle the strings on their own mostly to make code easier to follow.
        if (parserState.userQuery[parserState.pos] === "\"") {
            start += 1;
            getStringElem(query, parserState, isInGenerics);
            end = parserState.pos - 1;
        } else {
            end = getIdentEndPosition(parserState);
        }
        if (parserState.pos < parserState.length &&
            parserState.userQuery[parserState.pos] === "<")
        {
            if (isInGenerics) {
                throw new Error("Unexpected `<` after `<`");
            } else if (start >= end) {
                throw new Error("Found generics without a path");
            }
            parserState.pos += 1;
            getItemsBefore(query, parserState, generics, ">");
        }
        if (start >= end && generics.length === 0) {
            return;
        }
        elems.push(
            createQueryElement(
                query,
                parserState,
                parserState.userQuery.slice(start, end),
                generics,
                isInGenerics
            )
        );
    }

    /**
     * This function parses the next query element until it finds `endChar`, calling `getNextElem`
     * to collect each element.
     *
     * If there is no `endChar`, this function will implicitly stop at the end without raising an
     * error.
     *
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     * @param {Array<QueryElement>} elems - This is where the new {QueryElement} will be added.
     * @param {string} endChar            - This function will stop when it'll encounter this
     *                                      character.
     */
    function getItemsBefore(query, parserState, elems, endChar) {
        let foundStopChar = true;

        while (parserState.pos < parserState.length) {
            const c = parserState.userQuery[parserState.pos];
            if (c === endChar) {
                break;
            } else if (isSeparatorCharacter(c)) {
                parserState.pos += 1;
                foundStopChar = true;
                continue;
            } else if (c === ":" && isPathStart(parserState)) {
                throw new Error("Unexpected `::`: paths cannot start with `::`");
            } else if (c === ":" || isEndCharacter(c)) {
                let extra = "";
                if (endChar === ">") {
                    extra = "`<`";
                } else if (endChar === "") {
                    extra = "`->`";
                }
                throw new Error("Unexpected `" + c + "` after " + extra);
            }
            if (!foundStopChar) {
                if (endChar !== "") {
                    throw new Error(`Expected \`,\`, \` \` or \`${endChar}\`, found \`${c}\``);
                }
                throw new Error(`Expected \`,\` or \` \`, found \`${c}\``);
            }
            const posBefore = parserState.pos;
            getNextElem(query, parserState, elems, endChar === ">");
            // This case can be encountered if `getNextElem` encounted a "stop character" right from
            // the start. For example if you have `,,` or `<>`. In this case, we simply move up the
            // current position to continue the parsing.
            if (posBefore === parserState.pos) {
                parserState.pos += 1;
            }
            foundStopChar = false;
        }
        // We are either at the end of the string or on the `endChar`` character, let's move forward
        // in any case.
        parserState.pos += 1;
    }

    /**
     * Checks that the type filter doesn't have unwanted characters like `<>` (which are ignored
     * if empty).
     *
     * @param {ParserState} parserState
     */
    function checkExtraTypeFilterCharacters(parserState) {
        const query = parserState.userQuery;

        for (let pos = 0; pos < parserState.pos; ++pos) {
            if (!isIdentCharacter(query[pos]) && !isWhitespaceCharacter(query[pos])) {
                throw new Error(`Unexpected \`${query[pos]}\` in type filter`);
            }
        }
    }

    /**
     * Parses the provided `query` input to fill `parserState`. If it encounters an error while
     * parsing `query`, it'll throw an error.
     *
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     */
    function parseInput(query, parserState) {
        let c, before;
        let foundStopChar = true;

        while (parserState.pos < parserState.length) {
            c = parserState.userQuery[parserState.pos];
            if (isStopCharacter(c)) {
                foundStopChar = true;
                if (isSeparatorCharacter(c)) {
                    parserState.pos += 1;
                    continue;
                } else if (c === "-" || c === ">") {
                    if (isReturnArrow(parserState)) {
                        break;
                    }
                    throw new Error(`Unexpected \`${c}\` (did you mean \`->\`?)`);
                }
                throw new Error(`Unexpected \`${c}\``);
            } else if (c === ":" && !isPathStart(parserState)) {
                if (parserState.typeFilter !== null) {
                    throw new Error("Unexpected `:`");
                }
                if (query.elems.length === 0) {
                    throw new Error("Expected type filter before `:`");
                } else if (query.elems.length !== 1 || parserState.totalElems !== 1) {
                    throw new Error("Unexpected `:`");
                } else if (query.literalSearch) {
                    throw new Error("You cannot use quotes on type filter");
                }
                checkExtraTypeFilterCharacters(parserState);
                // The type filter doesn't count as an element since it's a modifier.
                parserState.typeFilter = query.elems.pop().name;
                parserState.pos += 1;
                parserState.totalElems = 0;
                query.literalSearch = false;
                foundStopChar = true;
                continue;
            }
            if (!foundStopChar) {
                if (parserState.typeFilter !== null) {
                    throw new Error(`Expected \`,\`, \` \` or \`->\`, found \`${c}\``);
                }
                throw new Error(`Expected \`,\`, \` \`, \`:\` or \`->\`, found \`${c}\``);
            }
            before = query.elems.length;
            getNextElem(query, parserState, query.elems, false);
            if (query.elems.length === before) {
                // Nothing was added, weird... Let's increase the position to not remain stuck.
                parserState.pos += 1;
            }
            foundStopChar = false;
        }
        while (parserState.pos < parserState.length) {
            c = parserState.userQuery[parserState.pos];
            if (isReturnArrow(parserState)) {
                parserState.pos += 2;
                // Get returned elements.
                getItemsBefore(query, parserState, query.returned, "");
                // Nothing can come afterward!
                if (query.returned.length === 0) {
                    throw new Error("Expected at least one item after `->`");
                }
                break;
            } else {
                parserState.pos += 1;
            }
        }
    }

    /**
     * Takes the user search input and returns an empty `ParsedQuery`.
     *
     * @param {string} userQuery
     *
     * @return {ParsedQuery}
     */
    function newParsedQuery(userQuery) {
        return {
            original: userQuery,
            userQuery: userQuery.toLowerCase(),
            typeFilter: NO_TYPE_FILTER,
            elems: [],
            returned: [],
            // Total number of "top" elements (does not include generics).
            foundElems: 0,
            literalSearch: false,
            error: null,
        };
    }

    /**
     * Build an URL with search parameters.
     *
     * @param {string} search            - The current search being performed.
     * @param {string|null} filterCrates - The current filtering crate (if any).
     *
     * @return {string}
     */
    function buildUrl(search, filterCrates) {
        let extra = "?search=" + encodeURIComponent(search);

        if (filterCrates !== null) {
            extra += "&filter-crate=" + encodeURIComponent(filterCrates);
        }
        return getNakedUrl() + extra + window.location.hash;
    }

    /**
     * Return the filtering crate or `null` if there is none.
     *
     * @return {string|null}
     */
    function getFilterCrates() {
        const elem = document.getElementById("crate-search");

        if (elem &&
            elem.value !== "All crates" &&
            hasOwnPropertyRustdoc(rawSearchIndex, elem.value))
        {
            return elem.value;
        }
        return null;
    }

    /**
     * Parses the query.
     *
     * The supported syntax by this parser is as follow:
     *
     * ident = *(ALPHA / DIGIT / "_") [!]
     * path = ident *(DOUBLE-COLON ident)
     * arg = path [generics]
     * arg-without-generic = path
     * type-sep = COMMA/WS *(COMMA/WS)
     * nonempty-arg-list = *(type-sep) arg *(type-sep arg) *(type-sep)
     * nonempty-arg-list-without-generics = *(type-sep) arg-without-generic
     *                                      *(type-sep arg-without-generic) *(type-sep)
     * generics = OPEN-ANGLE-BRACKET [ nonempty-arg-list-without-generics ] *(type-sep)
     *            CLOSE-ANGLE-BRACKET/EOF
     * return-args = RETURN-ARROW *(type-sep) nonempty-arg-list
     *
     * exact-search = [type-filter *WS COLON] [ RETURN-ARROW ] *WS QUOTE ident QUOTE [ generics ]
     * type-search = [type-filter *WS COLON] [ nonempty-arg-list ] [ return-args ]
     *
     * query = *WS (exact-search / type-search) *WS
     *
     * type-filter = (
     *     "mod" /
     *     "externcrate" /
     *     "import" /
     *     "struct" /
     *     "enum" /
     *     "fn" /
     *     "type" /
     *     "static" /
     *     "trait" /
     *     "impl" /
     *     "tymethod" /
     *     "method" /
     *     "structfield" /
     *     "variant" /
     *     "macro" /
     *     "primitive" /
     *     "associatedtype" /
     *     "constant" /
     *     "associatedconstant" /
     *     "union" /
     *     "foreigntype" /
     *     "keyword" /
     *     "existential" /
     *     "attr" /
     *     "derive" /
     *     "traitalias")
     *
     * OPEN-ANGLE-BRACKET = "<"
     * CLOSE-ANGLE-BRACKET = ">"
     * COLON = ":"
     * DOUBLE-COLON = "::"
     * QUOTE = %x22
     * COMMA = ","
     * RETURN-ARROW = "->"
     *
     * ALPHA = %x41-5A / %x61-7A ; A-Z / a-z
     * DIGIT = %x30-39
     * WS = %x09 / " "
     *
     * @param  {string} val     - The user query
     *
     * @return {ParsedQuery}    - The parsed query
     */
    function parseQuery(userQuery) {
        userQuery = userQuery.trim();
        const parserState = {
            length: userQuery.length,
            pos: 0,
            // Total number of elements (includes generics).
            totalElems: 0,
            genericsElems: 0,
            typeFilter: null,
            userQuery: userQuery.toLowerCase(),
        };
        let query = newParsedQuery(userQuery);

        try {
            parseInput(query, parserState);
            if (parserState.typeFilter !== null) {
                let typeFilter = parserState.typeFilter;
                if (typeFilter === "const") {
                    typeFilter = "constant";
                }
                query.typeFilter = itemTypeFromName(typeFilter);
            }
        } catch (err) {
            query = newParsedQuery(userQuery);
            query.error = err.message;
            query.typeFilter = -1;
            return query;
        }

        if (!query.literalSearch) {
            // If there is more than one element in the query, we switch to literalSearch in any
            // case.
            query.literalSearch = parserState.totalElems > 1;
        }
        query.foundElems = query.elems.length + query.returned.length;
        return query;
    }

    /**
     * Creates the query results.
     *
     * @param {Array<Result>} results_in_args
     * @param {Array<Result>} results_returned
     * @param {Array<Result>} results_in_args
     * @param {ParsedQuery} parsedQuery
     *
     * @return {ResultsTable}
     */
    function createQueryResults(results_in_args, results_returned, results_others, parsedQuery) {
        return {
            "in_args": results_in_args,
            "returned": results_returned,
            "others": results_others,
            "query": parsedQuery,
        };
    }

    /**
     * Executes the parsed query and builds a {ResultsTable}.
     *
     * @param  {ParsedQuery} parsedQuery - The parsed user query
     * @param  {Object} searchWords      - The list of search words to query against
     * @param  {Object} [filterCrates]   - Crate to search in if defined
     *
     * @return {ResultsTable}
     */
    function execQuery(parsedQuery, searchWords, filterCrates) {
        const results_others = {}, results_in_args = {}, results_returned = {};

        function transformResults(results) {
            const duplicates = {};
            const out = [];

            for (const result of results) {
                if (result.id > -1) {
                    const obj = searchIndex[result.id];
                    obj.lev = result.lev;
                    const res = buildHrefAndPath(obj);
                    obj.displayPath = pathSplitter(res[0]);
                    obj.fullPath = obj.displayPath + obj.name;
                    // To be sure than it some items aren't considered as duplicate.
                    obj.fullPath += "|" + obj.ty;

                    if (duplicates[obj.fullPath]) {
                        continue;
                    }
                    duplicates[obj.fullPath] = true;

                    obj.href = res[1];
                    out.push(obj);
                    if (out.length >= MAX_RESULTS) {
                        break;
                    }
                }
            }
            return out;
        }

        function sortResults(results, isType) {
            const userQuery = parsedQuery.userQuery;
            const ar = [];
            for (const entry in results) {
                if (hasOwnPropertyRustdoc(results, entry)) {
                    const result = results[entry];
                    result.word = searchWords[result.id];
                    result.item = searchIndex[result.id] || {};
                    ar.push(result);
                }
            }
            results = ar;
            // if there are no results then return to default and fail
            if (results.length === 0) {
                return [];
            }

            results.sort((aaa, bbb) => {
                let a, b;

                // sort by exact match with regard to the last word (mismatch goes later)
                a = (aaa.word !== userQuery);
                b = (bbb.word !== userQuery);
                if (a !== b) { return a - b; }

                // Sort by non levenshtein results and then levenshtein results by the distance
                // (less changes required to match means higher rankings)
                a = (aaa.lev);
                b = (bbb.lev);
                if (a !== b) { return a - b; }

                // sort by crate (non-current crate goes later)
                a = (aaa.item.crate !== window.currentCrate);
                b = (bbb.item.crate !== window.currentCrate);
                if (a !== b) { return a - b; }

                // sort by item name length (longer goes later)
                a = aaa.word.length;
                b = bbb.word.length;
                if (a !== b) { return a - b; }

                // sort by item name (lexicographically larger goes later)
                a = aaa.word;
                b = bbb.word;
                if (a !== b) { return (a > b ? +1 : -1); }

                // sort by index of keyword in item name (no literal occurrence goes later)
                a = (aaa.index < 0);
                b = (bbb.index < 0);
                if (a !== b) { return a - b; }
                // (later literal occurrence, if any, goes later)
                a = aaa.index;
                b = bbb.index;
                if (a !== b) { return a - b; }

                // special precedence for primitive and keyword pages
                if ((aaa.item.ty === TY_PRIMITIVE && bbb.item.ty !== TY_KEYWORD) ||
                    (aaa.item.ty === TY_KEYWORD && bbb.item.ty !== TY_PRIMITIVE)) {
                    return -1;
                }
                if ((bbb.item.ty === TY_PRIMITIVE && aaa.item.ty !== TY_PRIMITIVE) ||
                    (bbb.item.ty === TY_KEYWORD && aaa.item.ty !== TY_KEYWORD)) {
                    return 1;
                }

                // sort by description (no description goes later)
                a = (aaa.item.desc === "");
                b = (bbb.item.desc === "");
                if (a !== b) { return a - b; }

                // sort by type (later occurrence in `itemTypes` goes later)
                a = aaa.item.ty;
                b = bbb.item.ty;
                if (a !== b) { return a - b; }

                // sort by path (lexicographically larger goes later)
                a = aaa.item.path;
                b = bbb.item.path;
                if (a !== b) { return (a > b ? +1 : -1); }

                // que sera, sera
                return 0;
            });

            let nameSplit = null;
            if (parsedQuery.elems.length === 1) {
                const hasPath = typeof parsedQuery.elems[0].path === "undefined";
                nameSplit = hasPath ? null : parsedQuery.elems[0].path;
            }

            for (const result of results) {
                // this validation does not make sense when searching by types
                if (result.dontValidate) {
                    continue;
                }
                const name = result.item.name.toLowerCase(),
                    path = result.item.path.toLowerCase(),
                    parent = result.item.parent;

                if (!isType && !validateResult(name, path, nameSplit, parent)) {
                    result.id = -1;
                }
            }
            return transformResults(results);
        }

        /**
         * This function checks if the object (`row`) generics match the given type (`elem`)
         * generics. If there are no generics on `row`, `defaultLev` is returned.
         *
         * @param {Row} row            - The object to check.
         * @param {QueryElement} elem  - The element from the parsed query.
         * @param {integer} defaultLev - This is the value to return in case there are no generics.
         *
         * @return {integer}           - Returns the best match (if any) or `MAX_LEV_DISTANCE + 1`.
         */
        function checkGenerics(row, elem, defaultLev) {
            if (row.length <= GENERICS_DATA || row[GENERICS_DATA].length === 0) {
                return elem.generics.length === 0 ? defaultLev : MAX_LEV_DISTANCE + 1;
            } else if (row[GENERICS_DATA].length > 0 && row[GENERICS_DATA][0][NAME] === "") {
                if (row.length > GENERICS_DATA) {
                    return checkGenerics(row[GENERICS_DATA][0], elem, defaultLev);
                }
                return elem.generics.length === 0 ? defaultLev : MAX_LEV_DISTANCE + 1;
            }
            // The names match, but we need to be sure that all generics kinda
            // match as well.
            let elem_name;
            if (elem.generics.length > 0 && row[GENERICS_DATA].length >= elem.generics.length) {
                const elems = Object.create(null);
                for (const entry of row[GENERICS_DATA]) {
                    elem_name = entry[NAME];
                    if (elem_name === "") {
                        // Pure generic, needs to check into it.
                        if (checkGenerics(entry, elem, MAX_LEV_DISTANCE + 1) !== 0) {
                            return MAX_LEV_DISTANCE + 1;
                        }
                        continue;
                    }
                    if (elems[elem_name] === undefined) {
                        elems[elem_name] = 0;
                    }
                    elems[elem_name] += 1;
                }
                // We need to find the type that matches the most to remove it in order
                // to move forward.
                for (const generic of elem.generics) {
                    let match = null;
                    if (elems[generic.name]) {
                        match = generic.name;
                    } else {
                        for (elem_name in elems) {
                            if (!hasOwnPropertyRustdoc(elems, elem_name)) {
                                continue;
                            }
                            if (elem_name === generic) {
                                match = elem_name;
                                break;
                            }
                        }
                    }
                    if (match === null) {
                        return MAX_LEV_DISTANCE + 1;
                    }
                    elems[match] -= 1;
                    if (elems[match] === 0) {
                        delete elems[match];
                    }
                }
                return 0;
            }
            return MAX_LEV_DISTANCE + 1;
        }

        /**
          * This function checks if the object (`row`) matches the given type (`elem`) and its
          * generics (if any).
          *
          * @param {Row} row
          * @param {QueryElement} elem    - The element from the parsed query.
          *
          * @return {integer} - Returns a Levenshtein distance to the best match.
          */
        function checkIfInGenerics(row, elem) {
            let lev = MAX_LEV_DISTANCE + 1;
            for (const entry of row[GENERICS_DATA]) {
                lev = Math.min(checkType(entry, elem, true), lev);
                if (lev === 0) {
                    break;
                }
            }
            return lev;
        }

        /**
          * This function checks if the object (`row`) matches the given type (`elem`) and its
          * generics (if any).
          *
          * @param {Row} row
          * @param {QueryElement} elem      - The element from the parsed query.
          * @param {boolean} literalSearch
          *
          * @return {integer} - Returns a Levenshtein distance to the best match. If there is
          *                     no match, returns `MAX_LEV_DISTANCE + 1`.
          */
        function checkType(row, elem, literalSearch) {
            if (row[NAME].length === 0) {
                // This is a pure "generic" search, no need to run other checks.
                if (row.length > GENERICS_DATA) {
                    return checkIfInGenerics(row, elem);
                }
                return MAX_LEV_DISTANCE + 1;
            }

            let lev = levenshtein(row[NAME], elem.name);
            if (literalSearch) {
                if (lev !== 0) {
                    // The name didn't match, let's try to check if the generics do.
                    if (elem.generics.length === 0) {
                        const checkGeneric = (row.length > GENERICS_DATA &&
                            row[GENERICS_DATA].length > 0);
                        if (checkGeneric && row[GENERICS_DATA]
                            .findIndex(tmp_elem => tmp_elem[NAME] === elem.name) !== -1) {
                            return 0;
                        }
                    }
                    return MAX_LEV_DISTANCE + 1;
                } else if (elem.generics.length > 0) {
                    return checkGenerics(row, elem, MAX_LEV_DISTANCE + 1);
                }
                return 0;
            } else if (row.length > GENERICS_DATA) {
                if (elem.generics.length === 0) {
                    if (lev === 0) {
                        return 0;
                    }
                    // The name didn't match so we now check if the type we're looking for is inside
                    // the generics!
                    lev = checkIfInGenerics(row, elem);
                    // Now whatever happens, the returned distance is "less good" so we should mark
                    // it as such, and so we add 0.5 to the distance to make it "less good".
                    return lev + 0.5;
                } else if (lev > MAX_LEV_DISTANCE) {
                    // So our item's name doesn't match at all and has generics.
                    //
                    // Maybe it's present in a sub generic? For example "f<A<B<C>>>()", if we're
                    // looking for "B<C>", we'll need to go down.
                    return checkIfInGenerics(row, elem);
                } else {
                    // At this point, the name kinda match and we have generics to check, so
                    // let's go!
                    const tmp_lev = checkGenerics(row, elem, lev);
                    if (tmp_lev > MAX_LEV_DISTANCE) {
                        return MAX_LEV_DISTANCE + 1;
                    }
                    // We compute the median value of both checks and return it.
                    return (tmp_lev + lev) / 2;
                }
            } else if (elem.generics.length > 0) {
                // In this case, we were expecting generics but there isn't so we simply reject this
                // one.
                return MAX_LEV_DISTANCE + 1;
            }
            // No generics on our query or on the target type so we can return without doing
            // anything else.
            return lev;
        }

        /**
         * This function checks if the object (`row`) has an argument with the given type (`elem`).
         *
         * @param {Row} row
         * @param {QueryElement} elem    - The element from the parsed query.
         * @param {integer} typeFilter
         *
         * @return {integer} - Returns a Levenshtein distance to the best match. If there is no
         *                      match, returns `MAX_LEV_DISTANCE + 1`.
         */
        function findArg(row, elem, typeFilter) {
            let lev = MAX_LEV_DISTANCE + 1;

            if (row && row.type && row.type[INPUTS_DATA] && row.type[INPUTS_DATA].length > 0) {
                for (const input of row.type[INPUTS_DATA]) {
                    if (!typePassesFilter(typeFilter, input[1])) {
                        continue;
                    }
                    lev = Math.min(lev, checkType(input, elem, parsedQuery.literalSearch));
                    if (lev === 0) {
                        return 0;
                    }
                }
            }
            return parsedQuery.literalSearch ? MAX_LEV_DISTANCE + 1 : lev;
        }

        /**
         * This function checks if the object (`row`) returns the given type (`elem`).
         *
         * @param {Row} row
         * @param {QueryElement} elem   - The element from the parsed query.
         * @param {integer} typeFilter
         *
         * @return {integer} - Returns a Levenshtein distance to the best match. If there is no
         *                      match, returns `MAX_LEV_DISTANCE + 1`.
         */
        function checkReturned(row, elem, typeFilter) {
            let lev = MAX_LEV_DISTANCE + 1;

            if (row && row.type && row.type.length > OUTPUT_DATA) {
                let ret = row.type[OUTPUT_DATA];
                if (typeof ret[0] === "string") {
                    ret = [ret];
                }
                for (const ret_ty of ret) {
                    if (!typePassesFilter(typeFilter, ret_ty[1])) {
                        continue;
                    }
                    lev = Math.min(lev, checkType(ret_ty, elem, parsedQuery.literalSearch));
                    if (lev === 0) {
                        return 0;
                    }
                }
            }
            return parsedQuery.literalSearch ? MAX_LEV_DISTANCE + 1 : lev;
        }

        function checkPath(contains, lastElem, ty) {
            if (contains.length === 0) {
                return 0;
            }
            let ret_lev = MAX_LEV_DISTANCE + 1;
            const path = ty.path.split("::");

            if (ty.parent && ty.parent.name) {
                path.push(ty.parent.name.toLowerCase());
            }

            const length = path.length;
            const clength = contains.length;
            if (clength > length) {
                return MAX_LEV_DISTANCE + 1;
            }
            for (let i = 0; i < length; ++i) {
                if (i + clength > length) {
                    break;
                }
                let lev_total = 0;
                let aborted = false;
                for (let x = 0; x < clength; ++x) {
                    const lev = levenshtein(path[i + x], contains[x]);
                    if (lev > MAX_LEV_DISTANCE) {
                        aborted = true;
                        break;
                    }
                    lev_total += lev;
                }
                if (!aborted) {
                    ret_lev = Math.min(ret_lev, Math.round(lev_total / clength));
                }
            }
            return ret_lev;
        }

        function typePassesFilter(filter, type) {
            // No filter or Exact mach
            if (filter <= NO_TYPE_FILTER || filter === type) return true;

            // Match related items
            const name = itemTypes[type];
            switch (itemTypes[filter]) {
                case "constant":
                    return name === "associatedconstant";
                case "fn":
                    return name === "method" || name === "tymethod";
                case "type":
                    return name === "primitive" || name === "associatedtype";
                case "trait":
                    return name === "traitalias";
            }

            // No match
            return false;
        }

        function createAliasFromItem(item) {
            return {
                crate: item.crate,
                name: item.name,
                path: item.path,
                desc: item.desc,
                ty: item.ty,
                parent: item.parent,
                type: item.type,
                is_alias: true,
            };
        }

        function handleAliases(ret, query, filterCrates) {
            const lowerQuery = query.toLowerCase();
            // We separate aliases and crate aliases because we want to have current crate
            // aliases to be before the others in the displayed results.
            const aliases = [];
            const crateAliases = [];
            if (filterCrates !== null) {
                if (ALIASES[filterCrates] && ALIASES[filterCrates][lowerQuery]) {
                    const query_aliases = ALIASES[filterCrates][lowerQuery];
                    for (const alias of query_aliases) {
                        aliases.push(createAliasFromItem(searchIndex[alias]));
                    }
                }
            } else {
                Object.keys(ALIASES).forEach(crate => {
                    if (ALIASES[crate][lowerQuery]) {
                        const pushTo = crate === window.currentCrate ? crateAliases : aliases;
                        const query_aliases = ALIASES[crate][lowerQuery];
                        for (const alias of query_aliases) {
                            pushTo.push(createAliasFromItem(searchIndex[alias]));
                        }
                    }
                });
            }

            const sortFunc = (aaa, bbb) => {
                if (aaa.path < bbb.path) {
                    return 1;
                } else if (aaa.path === bbb.path) {
                    return 0;
                }
                return -1;
            };
            crateAliases.sort(sortFunc);
            aliases.sort(sortFunc);

            const pushFunc = alias => {
                alias.alias = query;
                const res = buildHrefAndPath(alias);
                alias.displayPath = pathSplitter(res[0]);
                alias.fullPath = alias.displayPath + alias.name;
                alias.href = res[1];

                ret.others.unshift(alias);
                if (ret.others.length > MAX_RESULTS) {
                    ret.others.pop();
                }
            };
            onEach(aliases, pushFunc);
            onEach(crateAliases, pushFunc);
        }

        /**
         * This function adds the given result into the provided `results` map if it matches the
         * following condition:
         *
         * * If it is a "literal search" (`parsedQuery.literalSearch`), then `lev` must be 0.
         * * If it is not a "literal search", `lev` must be <= `MAX_LEV_DISTANCE`.
         *
         * The `results` map contains information which will be used to sort the search results:
         *
         * * `fullId` is a `string`` used as the key of the object we use for the `results` map.
         * * `id` is the index in both `searchWords` and `searchIndex` arrays for this element.
         * * `index` is an `integer`` used to sort by the position of the word in the item's name.
         * * `lev` is the main metric used to sort the search results.
         *
         * @param {Results} results
         * @param {string} fullId
         * @param {integer} id
         * @param {integer} index
         * @param {integer} lev
         */
        function addIntoResults(results, fullId, id, index, lev) {
            if (lev === 0 || (!parsedQuery.literalSearch && lev <= MAX_LEV_DISTANCE)) {
                if (results[fullId] !== undefined) {
                    const result = results[fullId];
                    if (result.dontValidate || result.lev <= lev) {
                        return;
                    }
                }
                results[fullId] = {
                    id: id,
                    index: index,
                    dontValidate: parsedQuery.literalSearch,
                    lev: lev,
                };
            }
        }

        /**
         * This function is called in case the query is only one element (with or without generics).
         * This element will be compared to arguments' and returned values' items and also to items.
         *
         * Other important thing to note: since there is only one element, we use levenshtein
         * distance for name comparisons.
         *
         * @param {Row} row
         * @param {integer} pos              - Position in the `searchIndex`.
         * @param {QueryElement} elem        - The element from the parsed query.
         * @param {Results} results_others   - Unqualified results (not in arguments nor in
         *                                     returned values).
         * @param {Results} results_in_args  - Matching arguments results.
         * @param {Results} results_returned - Matching returned arguments results.
         */
        function handleSingleArg(
            row,
            pos,
            elem,
            results_others,
            results_in_args,
            results_returned
        ) {
            if (!row || (filterCrates !== null && row.crate !== filterCrates)) {
                return;
            }
            let lev, lev_add = 0, index = -1;
            const fullId = row.id;

            const in_args = findArg(row, elem, parsedQuery.typeFilter);
            const returned = checkReturned(row, elem, parsedQuery.typeFilter);

            addIntoResults(results_in_args, fullId, pos, index, in_args);
            addIntoResults(results_returned, fullId, pos, index, returned);

            if (!typePassesFilter(parsedQuery.typeFilter, row.ty)) {
                return;
            }
            const searchWord = searchWords[pos];

            if (parsedQuery.literalSearch) {
                if (searchWord === elem.name) {
                    addIntoResults(results_others, fullId, pos, -1, 0);
                }
                return;
            }

            // No need to check anything else if it's a "pure" generics search.
            if (elem.name.length === 0) {
                if (row.type !== null) {
                    lev = checkGenerics(row.type, elem, MAX_LEV_DISTANCE + 1);
                    addIntoResults(results_others, fullId, pos, index, lev);
                }
                return;
            }

            if (elem.fullPath.length > 1) {
                lev = checkPath(elem.pathWithoutLast, elem.pathLast, row);
                if (lev > MAX_LEV_DISTANCE || (parsedQuery.literalSearch && lev !== 0)) {
                    return;
                } else if (lev > 0) {
                    lev_add = lev / 10;
                }
            }

            if (searchWord.indexOf(elem.pathLast) > -1 ||
                row.normalizedName.indexOf(elem.pathLast) > -1)
            {
                // filter type: ... queries
                if (!results_others[fullId] !== undefined) {
                    index = row.normalizedName.indexOf(elem.pathLast);
                }
            }
            lev = levenshtein(searchWord, elem.pathLast);
            lev += lev_add;
            if (lev > 0 && elem.pathLast.length > 2 && searchWord.indexOf(elem.pathLast) > -1)
            {
                if (elem.pathLast.length < 6) {
                    lev = 1;
                } else {
                    lev = 0;
                }
            }
            if (lev > MAX_LEV_DISTANCE) {
                return;
            } else if (index !== -1 && elem.fullPath.length < 2) {
                lev -= 1;
            }
            if (lev < 0) {
                lev = 0;
            }
            addIntoResults(results_others, fullId, pos, index, lev);
        }

        /**
         * This function is called in case the query has more than one element. In this case, it'll
         * try to match the items which validates all the elements. For `aa -> bb` will look for
         * functions which have a parameter `aa` and has `bb` in its returned values.
         *
         * @param {Row} row
         * @param {integer} pos      - Position in the `searchIndex`.
         * @param {Object} results
         */
        function handleArgs(row, pos, results) {
            if (!row || (filterCrates !== null && row.crate !== filterCrates)) {
                return;
            }

            let totalLev = 0;
            let nbLev = 0;

            // If the result is too "bad", we return false and it ends this search.
            function checkArgs(elems, callback) {
                for (const elem of elems) {
                    // There is more than one parameter to the query so all checks should be "exact"
                    const lev = callback(row, elem, NO_TYPE_FILTER);
                    if (lev <= 1) {
                        nbLev += 1;
                        totalLev += lev;
                    } else {
                        return false;
                    }
                }
                return true;
            }
            if (!checkArgs(parsedQuery.elems, findArg)) {
                return;
            }
            if (!checkArgs(parsedQuery.returned, checkReturned)) {
                return;
            }

            if (nbLev === 0) {
                return;
            }
            const lev = Math.round(totalLev / nbLev);
            addIntoResults(results, row.id, pos, 0, lev);
        }

        function innerRunQuery() {
            let elem, i, nSearchWords, in_returned, row;

            if (parsedQuery.foundElems === 1) {
                if (parsedQuery.elems.length === 1) {
                    elem = parsedQuery.elems[0];
                    for (i = 0, nSearchWords = searchWords.length; i < nSearchWords; ++i) {
                        // It means we want to check for this element everywhere (in names, args and
                        // returned).
                        handleSingleArg(
                            searchIndex[i],
                            i,
                            elem,
                            results_others,
                            results_in_args,
                            results_returned
                        );
                    }
                } else if (parsedQuery.returned.length === 1) {
                    // We received one returned argument to check, so looking into returned values.
                    elem = parsedQuery.returned[0];
                    for (i = 0, nSearchWords = searchWords.length; i < nSearchWords; ++i) {
                        row = searchIndex[i];
                        in_returned = checkReturned(row, elem, parsedQuery.typeFilter);
                        addIntoResults(results_returned, row.id, i, -1, in_returned);
                    }
                }
            } else if (parsedQuery.foundElems > 0) {
                let container = results_others;
                // In the special case where only a "returned" information is available, we want to
                // put the information into the "results_returned" dict.
                if (parsedQuery.returned.length !== 0 && parsedQuery.elems.length === 0) {
                    container = results_returned;
                }
                for (i = 0, nSearchWords = searchWords.length; i < nSearchWords; ++i) {
                    handleArgs(searchIndex[i], i, container);
                }
            }
        }

        if (parsedQuery.error === null) {
            innerRunQuery();
        }

        const ret = createQueryResults(
            sortResults(results_in_args, true),
            sortResults(results_returned, true),
            sortResults(results_others, false),
            parsedQuery);
        handleAliases(ret, parsedQuery.original.replace(/"/g, ""), filterCrates);
        if (parsedQuery.error !== null && ret.others.length !== 0) {
            // It means some doc aliases were found so let's "remove" the error!
            ret.query.error = null;
        }
        return ret;
    }

    /**
     * Validate performs the following boolean logic. For example:
     * "File::open" will give IF A PARENT EXISTS => ("file" && "open")
     * exists in (name || path || parent) OR => ("file" && "open") exists in
     * (name || path )
     *
     * This could be written functionally, but I wanted to minimise
     * functions on stack.
     *
     * @param  {string} name   - The name of the result
     * @param  {string} path   - The path of the result
     * @param  {string} keys   - The keys to be used (["file", "open"])
     * @param  {Object} parent - The parent of the result
     *
     * @return {boolean}       - Whether the result is valid or not
     */
    function validateResult(name, path, keys, parent) {
        if (!keys || !keys.length) {
            return true;
        }
        for (const key of keys) {
            // each check is for validation so we negate the conditions and invalidate
            if (!(
                // check for an exact name match
                name.indexOf(key) > -1 ||
                // then an exact path match
                path.indexOf(key) > -1 ||
                // next if there is a parent, check for exact parent match
                (parent !== undefined && parent.name !== undefined &&
                    parent.name.toLowerCase().indexOf(key) > -1) ||
                // lastly check to see if the name was a levenshtein match
                levenshtein(name, key) <= MAX_LEV_DISTANCE)) {
                return false;
            }
        }
        return true;
    }

    function nextTab(direction) {
        const next = (searchState.currentTab + direction + 3) % searchState.focusedByTab.length;
        searchState.focusedByTab[searchState.currentTab] = document.activeElement;
        printTab(next);
        focusSearchResult();
    }

    // Focus the first search result on the active tab, or the result that
    // was focused last time this tab was active.
    function focusSearchResult() {
        const target = searchState.focusedByTab[searchState.currentTab] ||
            document.querySelectorAll(".search-results.active a").item(0) ||
            document.querySelectorAll("#titles > button").item(searchState.currentTab);
        if (target) {
            target.focus();
        }
    }

    function buildHrefAndPath(item) {
        let displayPath;
        let href;
        const type = itemTypes[item.ty];
        const name = item.name;
        let path = item.path;

        if (type === "mod") {
            displayPath = path + "::";
            href = window.rootPath + path.replace(/::/g, "/") + "/" +
                   name + "/index.html";
        } else if (type === "primitive" || type === "keyword") {
            displayPath = "";
            href = window.rootPath + path.replace(/::/g, "/") +
                   "/" + type + "." + name + ".html";
        } else if (type === "externcrate") {
            displayPath = "";
            href = window.rootPath + name + "/index.html";
        } else if (item.parent !== undefined) {
            const myparent = item.parent;
            let anchor = "#" + type + "." + name;
            const parentType = itemTypes[myparent.ty];
            let pageType = parentType;
            let pageName = myparent.name;

            if (parentType === "primitive") {
                displayPath = myparent.name + "::";
            } else if (type === "structfield" && parentType === "variant") {
                // Structfields belonging to variants are special: the
                // final path element is the enum name.
                const enumNameIdx = item.path.lastIndexOf("::");
                const enumName = item.path.substr(enumNameIdx + 2);
                path = item.path.substr(0, enumNameIdx);
                displayPath = path + "::" + enumName + "::" + myparent.name + "::";
                anchor = "#variant." + myparent.name + ".field." + name;
                pageType = "enum";
                pageName = enumName;
            } else {
                displayPath = path + "::" + myparent.name + "::";
            }
            href = window.rootPath + path.replace(/::/g, "/") +
                   "/" + pageType +
                   "." + pageName +
                   ".html" + anchor;
        } else {
            displayPath = item.path + "::";
            href = window.rootPath + item.path.replace(/::/g, "/") +
                   "/" + type + "." + name + ".html";
        }
        return [displayPath, href];
    }

    function escape(content) {
        const h1 = document.createElement("h1");
        h1.textContent = content;
        return h1.innerHTML;
    }

    function pathSplitter(path) {
        const tmp = "<span>" + path.replace(/::/g, "::</span><span>");
        if (tmp.endsWith("<span>")) {
            return tmp.slice(0, tmp.length - 6);
        }
        return tmp;
    }

    /**
     * Render a set of search results for a single tab.
     * @param {Array<?>}    array   - The search results for this tab
     * @param {ParsedQuery} query
     * @param {boolean}     display - True if this is the active tab
     */
    function addTab(array, query, display) {
        let extraClass = "";
        if (display === true) {
            extraClass = " active";
        }

        const output = document.createElement("div");
        let length = 0;
        if (array.length > 0) {
            output.className = "search-results " + extraClass;

            array.forEach(item => {
                const name = item.name;
                const type = itemTypes[item.ty];

                length += 1;

                let extra = "";
                if (type === "primitive") {
                    extra = " <i>(primitive type)</i>";
                } else if (type === "keyword") {
                    extra = " <i>(keyword)</i>";
                }

                const link = document.createElement("a");
                link.className = "result-" + type;
                link.href = item.href;

                const wrapper = document.createElement("div");
                const resultName = document.createElement("div");
                resultName.className = "result-name";

                if (item.is_alias) {
                    const alias = document.createElement("span");
                    alias.className = "alias";

                    const bold = document.createElement("b");
                    bold.innerText = item.alias;
                    alias.appendChild(bold);

                    alias.insertAdjacentHTML(
                        "beforeend",
                        "<span class=\"grey\"><i>&nbsp;- see&nbsp;</i></span>");

                    resultName.appendChild(alias);
                }
                resultName.insertAdjacentHTML(
                    "beforeend",
                    item.displayPath + "<span class=\"" + type + "\">" + name + extra + "</span>");
                wrapper.appendChild(resultName);

                const description = document.createElement("div");
                description.className = "desc";
                const spanDesc = document.createElement("span");
                spanDesc.insertAdjacentHTML("beforeend", item.desc);

                description.appendChild(spanDesc);
                wrapper.appendChild(description);
                link.appendChild(wrapper);
                output.appendChild(link);
            });
        } else if (query.error === null) {
            output.className = "search-failed" + extraClass;
            output.innerHTML = "No results :(<br/>" +
                "Try on <a href=\"https://duckduckgo.com/?q=" +
                encodeURIComponent("rust " + query.userQuery) +
                "\">DuckDuckGo</a>?<br/><br/>" +
                "Or try looking in one of these:<ul><li>The <a " +
                "href=\"https://doc.rust-lang.org/reference/index.html\">Rust Reference</a> " +
                " for technical details about the language.</li><li><a " +
                "href=\"https://doc.rust-lang.org/rust-by-example/index.html\">Rust By " +
                "Example</a> for expository code examples.</a></li><li>The <a " +
                "href=\"https://doc.rust-lang.org/book/index.html\">Rust Book</a> for " +
                "introductions to language features and the language itself.</li><li><a " +
                "href=\"https://docs.rs\">Docs.rs</a> for documentation of crates released on" +
                " <a href=\"https://crates.io/\">crates.io</a>.</li></ul>";
        }
        return [output, length];
    }

    function makeTabHeader(tabNb, text, nbElems) {
        if (searchState.currentTab === tabNb) {
            return "<button class=\"selected\">" + text +
                   " <div class=\"count\">(" + nbElems + ")</div></button>";
        }
        return "<button>" + text + " <div class=\"count\">(" + nbElems + ")</div></button>";
    }

    /**
     * @param {ResultsTable} results
     * @param {boolean} go_to_first
     * @param {string} filterCrates
     */
    function showResults(results, go_to_first, filterCrates) {
        const search = searchState.outputElement();
        if (go_to_first || (results.others.length === 1
            && getSettingValue("go-to-only-result") === "true"
            // By default, the search DOM element is "empty" (meaning it has no children not
            // text content). Once a search has been run, it won't be empty, even if you press
            // ESC or empty the search input (which also "cancels" the search).
            && (!search.firstChild || search.firstChild.innerText !== searchState.loadingText)))
        {
            const elem = document.createElement("a");
            elem.href = results.others[0].href;
            removeClass(elem, "active");
            // For firefox, we need the element to be in the DOM so it can be clicked.
            document.body.appendChild(elem);
            elem.click();
            return;
        }
        if (results.query === undefined) {
            results.query = parseQuery(searchState.input.value);
        }

        currentResults = results.query.userQuery;

        const ret_others = addTab(results.others, results.query, true);
        const ret_in_args = addTab(results.in_args, results.query, false);
        const ret_returned = addTab(results.returned, results.query, false);

        // Navigate to the relevant tab if the current tab is empty, like in case users search
        // for "-> String". If they had selected another tab previously, they have to click on
        // it again.
        let currentTab = searchState.currentTab;
        if ((currentTab === 0 && ret_others[1] === 0) ||
                (currentTab === 1 && ret_in_args[1] === 0) ||
                (currentTab === 2 && ret_returned[1] === 0)) {
            if (ret_others[1] !== 0) {
                currentTab = 0;
            } else if (ret_in_args[1] !== 0) {
                currentTab = 1;
            } else if (ret_returned[1] !== 0) {
                currentTab = 2;
            }
        }

        let crates = "";
        if (window.ALL_CRATES.length > 1) {
            crates = ` in <select id="crate-search"><option value="All crates">All crates</option>`;
            for (const c of window.ALL_CRATES) {
                crates += `<option value="${c}" ${c == filterCrates && "selected"}>${c}</option>`;
            }
            crates += `</select>`;
        }

        let typeFilter = "";
        if (results.query.typeFilter !== NO_TYPE_FILTER) {
            typeFilter = " (type: " + escape(itemTypes[results.query.typeFilter]) + ")";
        }

        let output = `<div id="search-settings">` +
            `<h1 class="search-results-title">Results for ${escape(results.query.userQuery)}` +
            `${typeFilter}</h1> in ${crates} </div>`;
        if (results.query.error !== null) {
            output += `<h3>Query parser error: "${results.query.error}".</h3>`;
        }
        output += `<div id="titles">` +
            makeTabHeader(0, "In Names", ret_others[1]) +
            makeTabHeader(1, "In Parameters", ret_in_args[1]) +
            makeTabHeader(2, "In Return Types", ret_returned[1]) +
            "</div>";

        const resultsElem = document.createElement("div");
        resultsElem.id = "results";
        resultsElem.appendChild(ret_others[0]);
        resultsElem.appendChild(ret_in_args[0]);
        resultsElem.appendChild(ret_returned[0]);

        search.innerHTML = output;
        const crateSearch = document.getElementById("crate-search");
        if (crateSearch) {
            crateSearch.addEventListener("input", updateCrate);
        }
        search.appendChild(resultsElem);
        // Reset focused elements.
        searchState.focusedByTab = [null, null, null];
        searchState.showResults(search);
        const elems = document.getElementById("titles").childNodes;
        elems[0].onclick = () => { printTab(0); };
        elems[1].onclick = () => { printTab(1); };
        elems[2].onclick = () => { printTab(2); };
        printTab(currentTab);
    }

    /**
     * Perform a search based on the current state of the search input element
     * and display the results.
     * @param {Event}   [e]       - The event that triggered this search, if any
     * @param {boolean} [forced]
     */
    function search(e, forced) {
        const params = searchState.getQueryStringParams();
        const query = parseQuery(searchState.input.value.trim());

        if (e) {
            e.preventDefault();
        }

        if (!forced && query.userQuery === currentResults) {
            if (query.userQuery.length > 0) {
                putBackSearch();
            }
            return;
        }

        let filterCrates = getFilterCrates();

        // In case we have no information about the saved crate and there is a URL query parameter,
        // we override it with the URL query parameter.
        if (filterCrates === null && params["filter-crate"] !== undefined) {
            filterCrates = params["filter-crate"];
        }

        // Update document title to maintain a meaningful browser history
        searchState.title = "Results for " + query.original + " - Rust";

        // Because searching is incremental by character, only the most
        // recent search query is added to the browser history.
        if (browserSupportsHistoryApi()) {
            const newURL = buildUrl(query.original, filterCrates);

            if (!history.state && !params.search) {
                history.pushState(null, "", newURL);
            } else {
                history.replaceState(null, "", newURL);
            }
        }

        showResults(
            execQuery(query, searchWords, filterCrates),
            params.go_to_first,
            filterCrates);
    }

    function buildIndex(rawSearchIndex) {
        searchIndex = [];
        /**
         * @type {Array<string>}
         */
        const searchWords = [];
        let i, word;
        let currentIndex = 0;
        let id = 0;

        for (const crate in rawSearchIndex) {
            if (!hasOwnPropertyRustdoc(rawSearchIndex, crate)) {
                continue;
            }

            let crateSize = 0;

            /**
             * The raw search data for a given crate. `n`, `t`, `d`, and `q`, `i`, and `f`
             * are arrays with the same length. n[i] contains the name of an item.
             * t[i] contains the type of that item (as a small integer that represents an
             * offset in `itemTypes`). d[i] contains the description of that item.
             *
             * q[i] contains the full path of the item, or an empty string indicating
             * "same as q[i-1]".
             *
             * i[i], f[i] are a mystery.
             *
             * `a` defines aliases with an Array of pairs: [name, offset], where `offset`
             * points into the n/t/d/q/i/f arrays.
             *
             * `doc` contains the description of the crate.
             *
             * `p` is a mystery and isn't the same length as n/t/d/q/i/f.
             *
             * @type {{
             *   doc: string,
             *   a: Object,
             *   n: Array<string>,
             *   t: Array<Number>,
             *   d: Array<string>,
             *   q: Array<string>,
             *   i: Array<Number>,
             *   f: Array<Array<?>>,
             *   p: Array<Object>,
             * }}
             */
            const crateCorpus = rawSearchIndex[crate];

            searchWords.push(crate);
            // This object should have exactly the same set of fields as the "row"
            // object defined below. Your JavaScript runtime will thank you.
            // https://mathiasbynens.be/notes/shapes-ics
            const crateRow = {
                crate: crate,
                ty: 1, // == ExternCrate
                name: crate,
                path: "",
                desc: crateCorpus.doc,
                parent: undefined,
                type: null,
                id: id,
                normalizedName: crate.indexOf("_") === -1 ? crate : crate.replace(/_/g, ""),
            };
            id += 1;
            searchIndex.push(crateRow);
            currentIndex += 1;

            // an array of (Number) item types
            const itemTypes = crateCorpus.t;
            // an array of (String) item names
            const itemNames = crateCorpus.n;
            // an array of (String) full paths (or empty string for previous path)
            const itemPaths = crateCorpus.q;
            // an array of (String) descriptions
            const itemDescs = crateCorpus.d;
            // an array of (Number) the parent path index + 1 to `paths`, or 0 if none
            const itemParentIdxs = crateCorpus.i;
            // an array of (Object | null) the type of the function, if any
            const itemFunctionSearchTypes = crateCorpus.f;
            // an array of [(Number) item type,
            //              (String) name]
            const paths = crateCorpus.p;
            // an array of [(String) alias name
            //             [Number] index to items]
            const aliases = crateCorpus.a;

            // convert `rawPaths` entries into object form
            let len = paths.length;
            for (i = 0; i < len; ++i) {
                paths[i] = {ty: paths[i][0], name: paths[i][1]};
            }

            // convert `item*` into an object form, and construct word indices.
            //
            // before any analysis is performed lets gather the search terms to
            // search against apart from the rest of the data.  This is a quick
            // operation that is cached for the life of the page state so that
            // all other search operations have access to this cached data for
            // faster analysis operations
            len = itemTypes.length;
            let lastPath = "";
            for (i = 0; i < len; ++i) {
                // This object should have exactly the same set of fields as the "crateRow"
                // object defined above.
                if (typeof itemNames[i] === "string") {
                    word = itemNames[i].toLowerCase();
                    searchWords.push(word);
                } else {
                    word = "";
                    searchWords.push("");
                }
                const row = {
                    crate: crate,
                    ty: itemTypes[i],
                    name: itemNames[i],
                    path: itemPaths[i] ? itemPaths[i] : lastPath,
                    desc: itemDescs[i],
                    parent: itemParentIdxs[i] > 0 ? paths[itemParentIdxs[i] - 1] : undefined,
                    type: itemFunctionSearchTypes[i],
                    id: id,
                    normalizedName: word.indexOf("_") === -1 ? word : word.replace(/_/g, ""),
                };
                id += 1;
                searchIndex.push(row);
                lastPath = row.path;
                crateSize += 1;
            }

            if (aliases) {
                ALIASES[crate] = {};
                for (const alias_name in aliases) {
                    if (!hasOwnPropertyRustdoc(aliases, alias_name)) {
                        continue;
                    }

                    if (!hasOwnPropertyRustdoc(ALIASES[crate], alias_name)) {
                        ALIASES[crate][alias_name] = [];
                    }
                    for (const local_alias of aliases[alias_name]) {
                        ALIASES[crate][alias_name].push(local_alias + currentIndex);
                    }
                }
            }
            currentIndex += crateSize;
        }
        return searchWords;
    }

    /**
     * Callback for when the search form is submitted.
     * @param {Event} [e] - The event that triggered this call, if any
     */
    function onSearchSubmit(e) {
        e.preventDefault();
        searchState.clearInputTimeout();
        search();
    }

    function putBackSearch() {
        const search_input = searchState.input;
        if (!searchState.input) {
            return;
        }
        if (search_input.value !== "" && !searchState.isDisplayed()) {
            searchState.showResults();
            if (browserSupportsHistoryApi()) {
                history.replaceState(null, "",
                    buildUrl(search_input.value, getFilterCrates()));
            }
            document.title = searchState.title;
        }
    }

    function registerSearchEvents() {
        const searchAfter500ms = () => {
            searchState.clearInputTimeout();
            if (searchState.input.value.length === 0) {
                if (browserSupportsHistoryApi()) {
                    history.replaceState(null, window.currentCrate + " - Rust",
                        getNakedUrl() + window.location.hash);
                }
                searchState.hideResults();
            } else {
                searchState.timeout = setTimeout(search, 500);
            }
        };
        searchState.input.onkeyup = searchAfter500ms;
        searchState.input.oninput = searchAfter500ms;
        document.getElementsByClassName("search-form")[0].onsubmit = onSearchSubmit;
        searchState.input.onchange = e => {
            if (e.target !== document.activeElement) {
                // To prevent doing anything when it's from a blur event.
                return;
            }
            // Do NOT e.preventDefault() here. It will prevent pasting.
            searchState.clearInputTimeout();
            // zero-timeout necessary here because at the time of event handler execution the
            // pasted content is not in the input field yet. Shouldn’t make any difference for
            // change, though.
            setTimeout(search, 0);
        };
        searchState.input.onpaste = searchState.input.onchange;

        searchState.outputElement().addEventListener("keydown", e => {
            // We only handle unmodified keystrokes here. We don't want to interfere with,
            // for instance, alt-left and alt-right for history navigation.
            if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) {
                return;
            }
            // up and down arrow select next/previous search result, or the
            // search box if we're already at the top.
            if (e.which === 38) { // up
                const previous = document.activeElement.previousElementSibling;
                if (previous) {
                    previous.focus();
                } else {
                    searchState.focus();
                }
                e.preventDefault();
            } else if (e.which === 40) { // down
                const next = document.activeElement.nextElementSibling;
                if (next) {
                    next.focus();
                }
                const rect = document.activeElement.getBoundingClientRect();
                if (window.innerHeight - rect.bottom < rect.height) {
                    window.scrollBy(0, rect.height);
                }
                e.preventDefault();
            } else if (e.which === 37) { // left
                nextTab(-1);
                e.preventDefault();
            } else if (e.which === 39) { // right
                nextTab(1);
                e.preventDefault();
            }
        });

        searchState.input.addEventListener("keydown", e => {
            if (e.which === 40) { // down
                focusSearchResult();
                e.preventDefault();
            }
        });

        searchState.input.addEventListener("focus", () => {
            putBackSearch();
        });

        searchState.input.addEventListener("blur", () => {
            searchState.input.placeholder = searchState.input.origPlaceholder;
        });

        // Push and pop states are used to add search results to the browser
        // history.
        if (browserSupportsHistoryApi()) {
            // Store the previous <title> so we can revert back to it later.
            const previousTitle = document.title;

            window.addEventListener("popstate", e => {
                const params = searchState.getQueryStringParams();
                // Revert to the previous title manually since the History
                // API ignores the title parameter.
                document.title = previousTitle;
                // When browsing forward to search results the previous
                // search will be repeated, so the currentResults are
                // cleared to ensure the search is successful.
                currentResults = null;
                // Synchronize search bar with query string state and
                // perform the search. This will empty the bar if there's
                // nothing there, which lets you really go back to a
                // previous state with nothing in the bar.
                if (params.search && params.search.length > 0) {
                    searchState.input.value = params.search;
                    // Some browsers fire "onpopstate" for every page load
                    // (Chrome), while others fire the event only when actually
                    // popping a state (Firefox), which is why search() is
                    // called both here and at the end of the startSearch()
                    // function.
                    search(e);
                } else {
                    searchState.input.value = "";
                    // When browsing back from search results the main page
                    // visibility must be reset.
                    searchState.hideResults();
                }
            });
        }

        // This is required in firefox to avoid this problem: Navigating to a search result
        // with the keyboard, hitting enter, and then hitting back would take you back to
        // the doc page, rather than the search that should overlay it.
        // This was an interaction between the back-forward cache and our handlers
        // that try to sync state between the URL and the search input. To work around it,
        // do a small amount of re-init on page show.
        window.onpageshow = () => {
            const qSearch = searchState.getQueryStringParams().search;
            if (searchState.input.value === "" && qSearch) {
                searchState.input.value = qSearch;
            }
            search();
        };
    }

    function updateCrate(ev) {
        if (ev.target.value === "All crates") {
            // If we don't remove it from the URL, it'll be picked up again by the search.
            const params = searchState.getQueryStringParams();
            const query = searchState.input.value.trim();
            if (!history.state && !params.search) {
                history.pushState(null, "", buildUrl(query, null));
            } else {
                history.replaceState(null, "", buildUrl(query, null));
            }
        }
        // In case you "cut" the entry from the search input, then change the crate filter
        // before paste back the previous search, you get the old search results without
        // the filter. To prevent this, we need to remove the previous results.
        currentResults = null;
        search(undefined, true);
    }

    /**
     *  @type {Array<string>}
     */
    const searchWords = buildIndex(rawSearchIndex);
    registerSearchEvents();

    function runSearchIfNeeded() {
        // If there's a search term in the URL, execute the search now.
        if (searchState.getQueryStringParams().search) {
            search();
        }
    }

    runSearchIfNeeded();
};

if (window.searchIndex !== undefined) {
    initSearch(window.searchIndex);
}

})();
