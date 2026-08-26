//#region node_modules/@lit/reactive-element/css-tag.js
var e = globalThis, t = e.ShadowRoot && (e.ShadyCSS === void 0 || e.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype, n = Symbol(), r = /* @__PURE__ */ new WeakMap(), i = class {
	constructor(e, t, r) {
		if (this._$cssResult$ = !0, r !== n) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
		this.cssText = e, this.t = t;
	}
	get styleSheet() {
		let e = this.o, n = this.t;
		if (t && e === void 0) {
			let t = n !== void 0 && n.length === 1;
			t && (e = r.get(n)), e === void 0 && ((this.o = e = new CSSStyleSheet()).replaceSync(this.cssText), t && r.set(n, e));
		}
		return e;
	}
	toString() {
		return this.cssText;
	}
}, a = (e) => new i(typeof e == "string" ? e : e + "", void 0, n), o = (e, ...t) => new i(e.length === 1 ? e[0] : t.reduce((t, n, r) => t + ((e) => {
	if (!0 === e._$cssResult$) return e.cssText;
	if (typeof e == "number") return e;
	throw Error("Value passed to 'css' function must be a 'css' function result: " + e + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
})(n) + e[r + 1], e[0]), e, n), s = (n, r) => {
	if (t) n.adoptedStyleSheets = r.map((e) => e instanceof CSSStyleSheet ? e : e.styleSheet);
	else for (let t of r) {
		let r = document.createElement("style"), i = e.litNonce;
		i !== void 0 && r.setAttribute("nonce", i), r.textContent = t.cssText, n.appendChild(r);
	}
}, c = t ? (e) => e : (e) => e instanceof CSSStyleSheet ? ((e) => {
	let t = "";
	for (let n of e.cssRules) t += n.cssText;
	return a(t);
})(e) : e, { is: l, defineProperty: u, getOwnPropertyDescriptor: d, getOwnPropertyNames: ee, getOwnPropertySymbols: te, getPrototypeOf: ne } = Object, f = globalThis, re = f.trustedTypes, ie = re ? re.emptyScript : "", ae = f.reactiveElementPolyfillSupport, p = (e, t) => e, m = {
	toAttribute(e, t) {
		switch (t) {
			case Boolean:
				e = e ? ie : null;
				break;
			case Object:
			case Array: e = e == null ? e : JSON.stringify(e);
		}
		return e;
	},
	fromAttribute(e, t) {
		let n = e;
		switch (t) {
			case Boolean:
				n = e !== null;
				break;
			case Number:
				n = e === null ? null : Number(e);
				break;
			case Object:
			case Array: try {
				n = JSON.parse(e);
			} catch {
				n = null;
			}
		}
		return n;
	}
}, oe = (e, t) => !l(e, t), se = {
	attribute: !0,
	type: String,
	converter: m,
	reflect: !1,
	useDefault: !1,
	hasChanged: oe
};
Symbol.metadata ??= Symbol("metadata"), f.litPropertyMetadata ??= /* @__PURE__ */ new WeakMap();
var h = class extends HTMLElement {
	static addInitializer(e) {
		this._$Ei(), (this.l ??= []).push(e);
	}
	static get observedAttributes() {
		return this.finalize(), this._$Eh && [...this._$Eh.keys()];
	}
	static createProperty(e, t = se) {
		if (t.state && (t.attribute = !1), this._$Ei(), this.prototype.hasOwnProperty(e) && ((t = Object.create(t)).wrapped = !0), this.elementProperties.set(e, t), !t.noAccessor) {
			let n = Symbol(), r = this.getPropertyDescriptor(e, n, t);
			r !== void 0 && u(this.prototype, e, r);
		}
	}
	static getPropertyDescriptor(e, t, n) {
		let { get: r, set: i } = d(this.prototype, e) ?? {
			get() {
				return this[t];
			},
			set(e) {
				this[t] = e;
			}
		};
		return {
			get: r,
			set(t) {
				let a = r?.call(this);
				i?.call(this, t), this.requestUpdate(e, a, n);
			},
			configurable: !0,
			enumerable: !0
		};
	}
	static getPropertyOptions(e) {
		return this.elementProperties.get(e) ?? se;
	}
	static _$Ei() {
		if (this.hasOwnProperty(p("elementProperties"))) return;
		let e = ne(this);
		e.finalize(), e.l !== void 0 && (this.l = [...e.l]), this.elementProperties = new Map(e.elementProperties);
	}
	static finalize() {
		if (this.hasOwnProperty(p("finalized"))) return;
		if (this.finalized = !0, this._$Ei(), this.hasOwnProperty(p("properties"))) {
			let e = this.properties, t = [...ee(e), ...te(e)];
			for (let n of t) this.createProperty(n, e[n]);
		}
		let e = this[Symbol.metadata];
		if (e !== null) {
			let t = litPropertyMetadata.get(e);
			if (t !== void 0) for (let [e, n] of t) this.elementProperties.set(e, n);
		}
		this._$Eh = /* @__PURE__ */ new Map();
		for (let [e, t] of this.elementProperties) {
			let n = this._$Eu(e, t);
			n !== void 0 && this._$Eh.set(n, e);
		}
		this.elementStyles = this.finalizeStyles(this.styles);
	}
	static finalizeStyles(e) {
		let t = [];
		if (Array.isArray(e)) {
			let n = new Set(e.flat(1 / 0).reverse());
			for (let e of n) t.unshift(c(e));
		} else e !== void 0 && t.push(c(e));
		return t;
	}
	static _$Eu(e, t) {
		let n = t.attribute;
		return !1 === n ? void 0 : typeof n == "string" ? n : typeof e == "string" ? e.toLowerCase() : void 0;
	}
	constructor() {
		super(), this._$Ep = void 0, this.isUpdatePending = !1, this.hasUpdated = !1, this._$Em = null, this._$Ev();
	}
	_$Ev() {
		this._$ES = new Promise((e) => this.enableUpdating = e), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), this.constructor.l?.forEach((e) => e(this));
	}
	addController(e) {
		(this._$EO ??= /* @__PURE__ */ new Set()).add(e), this.renderRoot !== void 0 && this.isConnected && e.hostConnected?.();
	}
	removeController(e) {
		this._$EO?.delete(e);
	}
	_$E_() {
		let e = /* @__PURE__ */ new Map(), t = this.constructor.elementProperties;
		for (let n of t.keys()) this.hasOwnProperty(n) && (e.set(n, this[n]), delete this[n]);
		e.size > 0 && (this._$Ep = e);
	}
	createRenderRoot() {
		let e = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
		return s(e, this.constructor.elementStyles), e;
	}
	connectedCallback() {
		this.renderRoot ??= this.createRenderRoot(), this.enableUpdating(!0), this._$EO?.forEach((e) => e.hostConnected?.());
	}
	enableUpdating(e) {}
	disconnectedCallback() {
		this._$EO?.forEach((e) => e.hostDisconnected?.());
	}
	attributeChangedCallback(e, t, n) {
		this._$AK(e, n);
	}
	_$ET(e, t) {
		let n = this.constructor.elementProperties.get(e), r = this.constructor._$Eu(e, n);
		if (r !== void 0 && !0 === n.reflect) {
			let i = (n.converter?.toAttribute === void 0 ? m : n.converter).toAttribute(t, n.type);
			this._$Em = e, i == null ? this.removeAttribute(r) : this.setAttribute(r, i), this._$Em = null;
		}
	}
	_$AK(e, t) {
		let n = this.constructor, r = n._$Eh.get(e);
		if (r !== void 0 && this._$Em !== r) {
			let e = n.getPropertyOptions(r), i = typeof e.converter == "function" ? { fromAttribute: e.converter } : e.converter?.fromAttribute === void 0 ? m : e.converter;
			this._$Em = r;
			let a = i.fromAttribute(t, e.type);
			this[r] = a ?? this._$Ej?.get(r) ?? a, this._$Em = null;
		}
	}
	requestUpdate(e, t, n, r = !1, i) {
		if (e !== void 0) {
			let a = this.constructor;
			if (!1 === r && (i = this[e]), n ??= a.getPropertyOptions(e), !((n.hasChanged ?? oe)(i, t) || n.useDefault && n.reflect && i === this._$Ej?.get(e) && !this.hasAttribute(a._$Eu(e, n)))) return;
			this.C(e, t, n);
		}
		!1 === this.isUpdatePending && (this._$ES = this._$EP());
	}
	C(e, t, { useDefault: n, reflect: r, wrapped: i }, a) {
		n && !(this._$Ej ??= /* @__PURE__ */ new Map()).has(e) && (this._$Ej.set(e, a ?? t ?? this[e]), !0 !== i || a !== void 0) || (this._$AL.has(e) || (this.hasUpdated || n || (t = void 0), this._$AL.set(e, t)), !0 === r && this._$Em !== e && (this._$Eq ??= /* @__PURE__ */ new Set()).add(e));
	}
	async _$EP() {
		this.isUpdatePending = !0;
		try {
			await this._$ES;
		} catch (e) {
			Promise.reject(e);
		}
		let e = this.scheduleUpdate();
		return e != null && await e, !this.isUpdatePending;
	}
	scheduleUpdate() {
		return this.performUpdate();
	}
	performUpdate() {
		if (!this.isUpdatePending) return;
		if (!this.hasUpdated) {
			if (this.renderRoot ??= this.createRenderRoot(), this._$Ep) {
				for (let [e, t] of this._$Ep) this[e] = t;
				this._$Ep = void 0;
			}
			let e = this.constructor.elementProperties;
			if (e.size > 0) for (let [t, n] of e) {
				let { wrapped: e } = n, r = this[t];
				!0 !== e || this._$AL.has(t) || r === void 0 || this.C(t, void 0, n, r);
			}
		}
		let e = !1, t = this._$AL;
		try {
			e = this.shouldUpdate(t), e ? (this.willUpdate(t), this._$EO?.forEach((e) => e.hostUpdate?.()), this.update(t)) : this._$EM();
		} catch (t) {
			throw e = !1, this._$EM(), t;
		}
		e && this._$AE(t);
	}
	willUpdate(e) {}
	_$AE(e) {
		this._$EO?.forEach((e) => e.hostUpdated?.()), this.hasUpdated || (this.hasUpdated = !0, this.firstUpdated(e)), this.updated(e);
	}
	_$EM() {
		this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = !1;
	}
	get updateComplete() {
		return this.getUpdateComplete();
	}
	getUpdateComplete() {
		return this._$ES;
	}
	shouldUpdate(e) {
		return !0;
	}
	update(e) {
		this._$Eq &&= this._$Eq.forEach((e) => this._$ET(e, this[e])), this._$EM();
	}
	updated(e) {}
	firstUpdated(e) {}
};
h.elementStyles = [], h.shadowRootOptions = { mode: "open" }, h[p("elementProperties")] = /* @__PURE__ */ new Map(), h[p("finalized")] = /* @__PURE__ */ new Map(), ae?.({ ReactiveElement: h }), (f.reactiveElementVersions ??= []).push("2.1.2");
//#endregion
//#region node_modules/lit-html/lit-html.js
var ce = globalThis, le = (e) => e, g = ce.trustedTypes, ue = g ? g.createPolicy("lit-html", { createHTML: (e) => e }) : void 0, de = "$lit$", _ = `lit$${Math.random().toFixed(9).slice(2)}$`, fe = "?" + _, pe = `<${fe}>`, v = document, y = () => v.createComment(""), b = (e) => e === null || typeof e != "object" && typeof e != "function", me = Array.isArray, he = (e) => me(e) || typeof e?.[Symbol.iterator] == "function", ge = "[ 	\n\f\r]", x = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g, _e = /-->/g, ve = />/g, S = RegExp(`>|${ge}(?:([^\\s"'>=/]+)(${ge}*=${ge}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`, "g"), ye = /'/g, be = /"/g, xe = /^(?:script|style|textarea|title)$/i, C = ((e) => (t, ...n) => ({
	_$litType$: e,
	strings: t,
	values: n
}))(1), w = Symbol.for("lit-noChange"), T = Symbol.for("lit-nothing"), Se = /* @__PURE__ */ new WeakMap(), E = v.createTreeWalker(v, 129);
function Ce(e, t) {
	if (!me(e) || !e.hasOwnProperty("raw")) throw Error("invalid template strings array");
	return ue === void 0 ? t : ue.createHTML(t);
}
var we = (e, t) => {
	let n = e.length - 1, r = [], i, a = t === 2 ? "<svg>" : t === 3 ? "<math>" : "", o = x;
	for (let t = 0; t < n; t++) {
		let n = e[t], s, c, l = -1, u = 0;
		for (; u < n.length && (o.lastIndex = u, c = o.exec(n), c !== null);) u = o.lastIndex, o === x ? c[1] === "!--" ? o = _e : c[1] === void 0 ? c[2] === void 0 ? c[3] !== void 0 && (o = S) : (xe.test(c[2]) && (i = RegExp("</" + c[2], "g")), o = S) : o = ve : o === S ? c[0] === ">" ? (o = i ?? x, l = -1) : c[1] === void 0 ? l = -2 : (l = o.lastIndex - c[2].length, s = c[1], o = c[3] === void 0 ? S : c[3] === "\"" ? be : ye) : o === be || o === ye ? o = S : o === _e || o === ve ? o = x : (o = S, i = void 0);
		let d = o === S && e[t + 1].startsWith("/>") ? " " : "";
		a += o === x ? n + pe : l >= 0 ? (r.push(s), n.slice(0, l) + de + n.slice(l) + _ + d) : n + _ + (l === -2 ? t : d);
	}
	return [Ce(e, a + (e[n] || "<?>") + (t === 2 ? "</svg>" : t === 3 ? "</math>" : "")), r];
}, D = class e {
	constructor({ strings: t, _$litType$: n }, r) {
		let i;
		this.parts = [];
		let a = 0, o = 0, s = t.length - 1, c = this.parts, [l, u] = we(t, n);
		if (this.el = e.createElement(l, r), E.currentNode = this.el.content, n === 2 || n === 3) {
			let e = this.el.content.firstChild;
			e.replaceWith(...e.childNodes);
		}
		for (; (i = E.nextNode()) !== null && c.length < s;) {
			if (i.nodeType === 1) {
				if (i.hasAttributes()) for (let e of i.getAttributeNames()) if (e.endsWith(de)) {
					let t = u[o++], n = i.getAttribute(e).split(_), r = /([.?@])?(.*)/.exec(t);
					c.push({
						type: 1,
						index: a,
						name: r[2],
						strings: n,
						ctor: r[1] === "." ? Ee : r[1] === "?" ? De : r[1] === "@" ? Oe : A
					}), i.removeAttribute(e);
				} else e.startsWith(_) && (c.push({
					type: 6,
					index: a
				}), i.removeAttribute(e));
				if (xe.test(i.tagName)) {
					let e = i.textContent.split(_), t = e.length - 1;
					if (t > 0) {
						i.textContent = g ? g.emptyScript : "";
						for (let n = 0; n < t; n++) i.append(e[n], y()), E.nextNode(), c.push({
							type: 2,
							index: ++a
						});
						i.append(e[t], y());
					}
				}
			} else if (i.nodeType === 8) {
				if (i.data === fe) c.push({
					type: 2,
					index: a
				});
				else {
					let e = -1;
					for (; (e = i.data.indexOf(_, e + 1)) !== -1;) c.push({
						type: 7,
						index: a
					}), e += _.length - 1;
				}
			}
			a++;
		}
	}
	static createElement(e, t) {
		let n = v.createElement("template");
		return n.innerHTML = e, n;
	}
};
function O(e, t, n = e, r) {
	if (t === w) return t;
	let i = r === void 0 ? n._$Cl : n._$Co?.[r], a = b(t) ? void 0 : t._$litDirective$;
	return i?.constructor !== a && (i?._$AO?.(!1), a === void 0 ? i = void 0 : (i = new a(e), i._$AT(e, n, r)), r === void 0 ? n._$Cl = i : (n._$Co ??= [])[r] = i), i !== void 0 && (t = O(e, i._$AS(e, t.values), i, r)), t;
}
var Te = class {
	constructor(e, t) {
		this._$AV = [], this._$AN = void 0, this._$AD = e, this._$AM = t;
	}
	get parentNode() {
		return this._$AM.parentNode;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	u(e) {
		let { el: { content: t }, parts: n } = this._$AD, r = (e?.creationScope ?? v).importNode(t, !0);
		E.currentNode = r;
		let i = E.nextNode(), a = 0, o = 0, s = n[0];
		for (; s !== void 0;) {
			if (a === s.index) {
				let t;
				s.type === 2 ? t = new k(i, i.nextSibling, this, e) : s.type === 1 ? t = new s.ctor(i, s.name, s.strings, this, e) : s.type === 6 && (t = new ke(i, this, e)), this._$AV.push(t), s = n[++o];
			}
			a !== s?.index && (i = E.nextNode(), a++);
		}
		return E.currentNode = v, r;
	}
	p(e) {
		let t = 0;
		for (let n of this._$AV) n !== void 0 && (n.strings === void 0 ? n._$AI(e[t]) : (n._$AI(e, n, t), t += n.strings.length - 2)), t++;
	}
}, k = class e {
	get _$AU() {
		return this._$AM?._$AU ?? this._$Cv;
	}
	constructor(e, t, n, r) {
		this.type = 2, this._$AH = T, this._$AN = void 0, this._$AA = e, this._$AB = t, this._$AM = n, this.options = r, this._$Cv = r?.isConnected ?? !0;
	}
	get parentNode() {
		let e = this._$AA.parentNode, t = this._$AM;
		return t !== void 0 && e?.nodeType === 11 && (e = t.parentNode), e;
	}
	get startNode() {
		return this._$AA;
	}
	get endNode() {
		return this._$AB;
	}
	_$AI(e, t = this) {
		e = O(this, e, t), b(e) ? e === T || e == null || e === "" ? (this._$AH !== T && this._$AR(), this._$AH = T) : e !== this._$AH && e !== w && this._(e) : e._$litType$ === void 0 ? e.nodeType === void 0 ? he(e) ? this.k(e) : this._(e) : this.T(e) : this.$(e);
	}
	O(e) {
		return this._$AA.parentNode.insertBefore(e, this._$AB);
	}
	T(e) {
		this._$AH !== e && (this._$AR(), this._$AH = this.O(e));
	}
	_(e) {
		this._$AH !== T && b(this._$AH) ? this._$AA.nextSibling.data = e : this.T(v.createTextNode(e)), this._$AH = e;
	}
	$(e) {
		let { values: t, _$litType$: n } = e, r = typeof n == "number" ? this._$AC(e) : (n.el === void 0 && (n.el = D.createElement(Ce(n.h, n.h[0]), this.options)), n);
		if (this._$AH?._$AD === r) this._$AH.p(t);
		else {
			let e = new Te(r, this), n = e.u(this.options);
			e.p(t), this.T(n), this._$AH = e;
		}
	}
	_$AC(e) {
		let t = Se.get(e.strings);
		return t === void 0 && Se.set(e.strings, t = new D(e)), t;
	}
	k(t) {
		me(this._$AH) || (this._$AH = [], this._$AR());
		let n = this._$AH, r, i = 0;
		for (let a of t) i === n.length ? n.push(r = new e(this.O(y()), this.O(y()), this, this.options)) : r = n[i], r._$AI(a), i++;
		i < n.length && (this._$AR(r && r._$AB.nextSibling, i), n.length = i);
	}
	_$AR(e = this._$AA.nextSibling, t) {
		for (this._$AP?.(!1, !0, t); e !== this._$AB;) {
			let t = le(e).nextSibling;
			le(e).remove(), e = t;
		}
	}
	setConnected(e) {
		this._$AM === void 0 && (this._$Cv = e, this._$AP?.(e));
	}
}, A = class {
	get tagName() {
		return this.element.tagName;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	constructor(e, t, n, r, i) {
		this.type = 1, this._$AH = T, this._$AN = void 0, this.element = e, this.name = t, this._$AM = r, this.options = i, n.length > 2 || n[0] !== "" || n[1] !== "" ? (this._$AH = Array(n.length - 1).fill(/* @__PURE__ */ new String()), this.strings = n) : this._$AH = T;
	}
	_$AI(e, t = this, n, r) {
		let i = this.strings, a = !1;
		if (i === void 0) e = O(this, e, t, 0), a = !b(e) || e !== this._$AH && e !== w, a && (this._$AH = e);
		else {
			let r = e, o, s;
			for (e = i[0], o = 0; o < i.length - 1; o++) s = O(this, r[n + o], t, o), s === w && (s = this._$AH[o]), a ||= !b(s) || s !== this._$AH[o], s === T ? e = T : e !== T && (e += (s ?? "") + i[o + 1]), this._$AH[o] = s;
		}
		a && !r && this.j(e);
	}
	j(e) {
		e === T ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, e ?? "");
	}
}, Ee = class extends A {
	constructor() {
		super(...arguments), this.type = 3;
	}
	j(e) {
		this.element[this.name] = e === T ? void 0 : e;
	}
}, De = class extends A {
	constructor() {
		super(...arguments), this.type = 4;
	}
	j(e) {
		this.element.toggleAttribute(this.name, !!e && e !== T);
	}
}, Oe = class extends A {
	constructor(e, t, n, r, i) {
		super(e, t, n, r, i), this.type = 5;
	}
	_$AI(e, t = this) {
		if ((e = O(this, e, t, 0) ?? T) === w) return;
		let n = this._$AH, r = e === T && n !== T || e.capture !== n.capture || e.once !== n.once || e.passive !== n.passive, i = e !== T && (n === T || r);
		r && this.element.removeEventListener(this.name, this, n), i && this.element.addEventListener(this.name, this, e), this._$AH = e;
	}
	handleEvent(e) {
		typeof this._$AH == "function" ? this._$AH.call(this.options?.host ?? this.element, e) : this._$AH.handleEvent(e);
	}
}, ke = class {
	constructor(e, t, n) {
		this.element = e, this.type = 6, this._$AN = void 0, this._$AM = t, this.options = n;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	_$AI(e) {
		O(this, e);
	}
}, Ae = ce.litHtmlPolyfillSupport;
Ae?.(D, k), (ce.litHtmlVersions ??= []).push("3.3.3");
var je = (e, t, n) => {
	let r = n?.renderBefore ?? t, i = r._$litPart$;
	if (i === void 0) {
		let e = n?.renderBefore ?? null;
		r._$litPart$ = i = new k(t.insertBefore(y(), e), e, void 0, n ?? {});
	}
	return i._$AI(e), i;
}, j = globalThis, M = class extends h {
	constructor() {
		super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
	}
	createRenderRoot() {
		let e = super.createRenderRoot();
		return this.renderOptions.renderBefore ??= e.firstChild, e;
	}
	update(e) {
		let t = this.render();
		this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(e), this._$Do = je(t, this.renderRoot, this.renderOptions);
	}
	connectedCallback() {
		super.connectedCallback(), this._$Do?.setConnected(!0);
	}
	disconnectedCallback() {
		super.disconnectedCallback(), this._$Do?.setConnected(!1);
	}
	render() {
		return w;
	}
};
M._$litElement$ = !0, M.finalized = !0, j.litElementHydrateSupport?.({ LitElement: M });
var Me = j.litElementPolyfillSupport;
Me?.({ LitElement: M }), (j.litElementVersions ??= []).push("4.2.2");
//#endregion
//#region node_modules/@lit/reactive-element/decorators/property.js
var Ne = {
	attribute: !0,
	type: String,
	converter: m,
	reflect: !1,
	hasChanged: oe
}, Pe = (e = Ne, t, n) => {
	let { kind: r, metadata: i } = n, a = globalThis.litPropertyMetadata.get(i);
	if (a === void 0 && globalThis.litPropertyMetadata.set(i, a = /* @__PURE__ */ new Map()), r === "setter" && ((e = Object.create(e)).wrapped = !0), a.set(n.name, e), r === "accessor") {
		let { name: r } = n;
		return {
			set(n) {
				let i = t.get.call(this);
				t.set.call(this, n), this.requestUpdate(r, i, e, !0, n);
			},
			init(t) {
				return t !== void 0 && this.C(r, void 0, e, t), t;
			}
		};
	}
	if (r === "setter") {
		let { name: r } = n;
		return function(n) {
			let i = this[r];
			t.call(this, n), this.requestUpdate(r, i, e, !0, n);
		};
	}
	throw Error("Unsupported decorator location: " + r);
};
function Fe(e) {
	return (t, n) => typeof n == "object" ? Pe(e, t, n) : ((e, t, n) => {
		let r = t.hasOwnProperty(n);
		return t.constructor.createProperty(n, e), r ? Object.getOwnPropertyDescriptor(t, n) : void 0;
	})(e, t, n);
}
//#endregion
//#region node_modules/@lit/reactive-element/decorators/state.js
function N(e) {
	return Fe({
		...e,
		state: !0,
		attribute: !1
	});
}
function Ie(e) {
	return {
		entity: e.camera,
		tap_action: e.tap_action,
		hold_action: e.hold_action,
		double_tap_action: e.double_tap_action
	};
}
function Le(e, t) {
	switch (t) {
		case "hold": return e.hold_action;
		case "double_tap": return e.double_tap_action;
		default: return e.tap_action;
	}
}
function Re(e, t, n) {
	let r = {
		config: Ie(t),
		action: n
	};
	e.dispatchEvent(new CustomEvent("hass-action", {
		detail: r,
		bubbles: !0,
		composed: !0
	}));
}
function ze(e) {
	return e.tap_action.action !== "none";
}
var Be = class {
	constructor(e) {
		this.targetEl = null, this.gesture = null, this.onPointerDown = (e) => {
			if (e.isPrimary === !1 || e.button > 0 || this.gesture) return;
			let t = this.options.getConfig();
			t && (this.gesture = {
				pointerId: e.pointerId,
				startX: e.clientX,
				startY: e.clientY,
				held: !1
			}, t.hold_action.action !== "none" && (this.holdTimer = setTimeout(() => {
				this.holdTimer = void 0, this.gesture && (this.gesture.held = !0);
			}, 500)));
		}, this.onPointerMove = (e) => {
			let t = this.gesture;
			!t || t.pointerId !== e.pointerId || Math.hypot(e.clientX - t.startX, e.clientY - t.startY) > 10 && this.cancelGesture();
		}, this.onPointerUp = (e) => {
			let t = this.gesture;
			if (!t || t.pointerId !== e.pointerId) return;
			this.gesture = null, this.clearHoldTimer();
			let n = this.options.getConfig();
			if (!n) {
				this.clearPendingTap();
				return;
			}
			if (t.held) {
				this.clearPendingTap(), this.fire("hold", n);
				return;
			}
			if (this.pendingTapTimer !== void 0) {
				this.clearPendingTap(), this.fire("double_tap", n);
				return;
			}
			if (n.double_tap_action.action !== "none") {
				this.pendingTapTimer = setTimeout(() => {
					this.pendingTapTimer = void 0;
					let e = this.options.getConfig();
					e && this.fire("tap", e);
				}, 250);
				return;
			}
			this.fire("tap", n);
		}, this.onPointerCancel = (e) => {
			this.gesture && this.gesture.pointerId !== e.pointerId || this.cancelGesture();
		}, this.onContextMenu = (e) => {
			this.gesture && this.options.getConfig()?.hold_action.action !== "none" && e.preventDefault();
		}, this.onKeyDown = (e) => {
			if (e.repeat || e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
			let t = this.options.getConfig();
			!t || !ze(t) || (e.preventDefault(), this.cancelGesture(), this.clearPendingTap(), this.fire("tap", t));
		}, this.options = e;
	}
	get target() {
		return this.targetEl;
	}
	attach(e) {
		this.targetEl !== e && (this.detach(), this.targetEl = e, e.addEventListener("pointerdown", this.onPointerDown), e.addEventListener("pointermove", this.onPointerMove), e.addEventListener("pointerup", this.onPointerUp), e.addEventListener("pointercancel", this.onPointerCancel), e.addEventListener("pointerleave", this.onPointerCancel), e.addEventListener("contextmenu", this.onContextMenu), e.addEventListener("keydown", this.onKeyDown));
	}
	detach() {
		let e = this.targetEl;
		this.cancelGesture(), this.clearPendingTap(), this.targetEl = null, e && (e.removeEventListener("pointerdown", this.onPointerDown), e.removeEventListener("pointermove", this.onPointerMove), e.removeEventListener("pointerup", this.onPointerUp), e.removeEventListener("pointercancel", this.onPointerCancel), e.removeEventListener("pointerleave", this.onPointerCancel), e.removeEventListener("contextmenu", this.onContextMenu), e.removeEventListener("keydown", this.onKeyDown));
	}
	fire(e, t) {
		if (Le(t, e).action === "none") return;
		let n = this.options.getEventTarget?.() ?? this.targetEl;
		n && Re(n, t, e);
	}
	cancelGesture() {
		this.gesture = null, this.clearHoldTimer();
	}
	clearHoldTimer() {
		this.holdTimer !== void 0 && (clearTimeout(this.holdTimer), this.holdTimer = void 0);
	}
	clearPendingTap() {
		this.pendingTapTimer !== void 0 && (clearTimeout(this.pendingTapTimer), this.pendingTapTimer = void 0);
	}
}, P = class extends Error {
	constructor(e, t, n) {
		super(t), this.name = "EndpointError", this.code = e, this.cause = n?.cause;
	}
}, Ve = /* @__PURE__ */ new Map();
function F(e) {
	return typeof e == "string" && e !== "" ? e : void 0;
}
function He(e, t) {
	let n = e.states?.[t];
	if (!n) throw new P("entity-not-found", `Camera entity "${t}" was not found in Home Assistant. Check the entity id, and that the Frigate integration is loaded.`);
	return n;
}
function Ue(e, t) {
	let n = He(e, t.camera), r = Ve.get(t.camera), i = F(n.attributes?.client_id), a = F(n.attributes?.camera_name);
	i !== void 0 && Ve.set(t.camera, {
		clientId: i,
		cameraName: a
	});
	let o = i ?? r?.clientId;
	if (o === void 0) throw n.state === "unavailable" ? new P("missing-client-id", `Camera entity "${t.camera}" is currently unavailable in Home Assistant.`) : new P("missing-client-id", `Camera entity "${t.camera}" has no "client_id" attribute, so it is not a Frigate camera provided by frigate-hass-integration >= 5.12.0.`);
	let s = F(t.stream) ?? a ?? r?.cameraName;
	if (s === void 0) throw new P("missing-stream-name", `Camera entity "${t.camera}" has no "camera_name" attribute. Set "stream:" in the card config to name the go2rtc stream explicitly.`);
	return `/api/frigate/${encodeURIComponent(o)}/go2rtc/ws/api/ws?src=${encodeURIComponent(s)}`;
}
function We(e) {
	return `/api/camera_proxy/${encodeURIComponent(e)}`;
}
async function Ge(e, t, n = 300) {
	let r;
	try {
		r = await e.callWS({
			type: "auth/sign_path",
			path: t,
			expires: n
		});
	} catch (e) {
		throw new P("sign-failed", `Home Assistant refused to sign "${t}": ${Ze(e)}`, { cause: e });
	}
	if (!r || typeof r.path != "string" || r.path === "") throw new P("sign-failed", `Home Assistant returned no signed path for "${t}".`);
	return r.path;
}
function Ke(e, t = location) {
	let n = new URL(e, t.href);
	return n.protocol = n.protocol === "https:" ? "wss:" : "ws:", n.toString();
}
function qe(e, t = location) {
	return new URL(e, t.href).toString();
}
async function Je(e, t) {
	return Ke(await Ge(e, Ue(e, t)));
}
async function Ye(e, t) {
	return e.states?.[t.camera] ? qe(await Ge(e, We(t.camera))) : null;
}
var Xe = {
	resolveSignedWsUrl: Je,
	resolvePosterUrl: Ye
};
function Ze(e) {
	return e instanceof Error ? e.message : typeof e == "string" ? e : e && typeof e == "object" && "message" in e ? String(e.message) : String(e);
}
//#endregion
//#region src/types.ts
var I = "simpler-camera-card", L = `custom:${I}`, R = [
	"more-info",
	"toggle",
	"navigate",
	"url",
	"perform-action",
	"assist",
	"none"
], Qe = ["mse", "webrtc"], $e = [
	"none",
	"name",
	"custom"
], z = {
	transport: "mse",
	overlay: "none",
	aspectRatio: "16 / 9",
	tapAction: { action: "more-info" },
	holdAction: { action: "none" },
	doubleTapAction: { action: "none" },
	reloadAfterMinutesDown: 0
}, et = 3, tt = 2e3, nt = 5e3, rt = 2, it = 6e5, at = .5, ot = 1, st = 1e4, ct = 5e3, lt = 5e3, ut = 1e4, B = "[simpler-camera-card]", dt = class {
	constructor(e, t = {}) {
		this.subscriptions = /* @__PURE__ */ new Map(), this.outbound = [], this.socket = null, this.opened = !1, this.finished = !1, this.onOpen = () => {}, this.onBinary = () => {}, this.onClose = () => {}, this.onError = () => {}, this.url = e, this.webSocketImpl = t.webSocketImpl ?? globalThis.WebSocket ?? void 0;
	}
	get isOpen() {
		return this.opened && !this.finished;
	}
	get isFinished() {
		return this.finished;
	}
	connect() {
		if (this.finished || this.socket) return;
		let e;
		try {
			e = new this.webSocketImpl(this.url);
		} catch (e) {
			console.info(`${B} go2rtc websocket could not be created:`, e), this.finished = !0, this.onError();
			return;
		}
		e.binaryType = "arraybuffer", e.onopen = () => this.handleOpen(), e.onmessage = (e) => this.handleMessage(e), e.onclose = (e) => this.handleClose(e), e.onerror = () => this.handleError(), this.socket = e;
	}
	send(e) {
		if (this.finished) return;
		let t = JSON.stringify(e);
		this.isOpen && this.socket ? this.write(t) : this.outbound.push(t);
	}
	on(e, t) {
		if (this.finished) return () => {};
		let n = this.subscriptions.get(e);
		return n || (n = /* @__PURE__ */ new Set(), this.subscriptions.set(e, n)), n.add(t), () => {
			n.delete(t);
		};
	}
	close() {
		this.finished = !0, this.opened = !1, this.subscriptions.clear(), this.outbound.length = 0, this.releaseSocket();
	}
	releaseSocket() {
		let e = this.socket;
		if (this.socket = null, e) {
			e.onopen = null, e.onmessage = null, e.onclose = null, e.onerror = null;
			try {
				e.close();
			} catch (e) {
				console.info(`${B} go2rtc websocket close() threw:`, e);
			}
		}
	}
	handleOpen() {
		if (this.finished) return;
		this.opened = !0;
		let e = this.outbound.splice(0, this.outbound.length);
		for (let t of e) this.write(t);
		this.onOpen();
	}
	write(e) {
		try {
			this.socket?.send(e);
		} catch (e) {
			console.info(`${B} go2rtc websocket send() failed:`, e);
		}
	}
	handleMessage(e) {
		if (this.finished) return;
		let t = e.data;
		if (typeof t == "string") {
			this.dispatchJson(t);
			return;
		}
		if (t instanceof ArrayBuffer) {
			this.onBinary(t);
			return;
		}
		if (ArrayBuffer.isView(t)) {
			let e = t;
			this.onBinary(e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength));
			return;
		}
		console.info(`${B} ignoring go2rtc frame of unsupported type`);
	}
	dispatchJson(e) {
		let t;
		try {
			t = JSON.parse(e);
		} catch {
			console.info(`${B} ignoring non-JSON go2rtc text frame`);
			return;
		}
		if (typeof t != "object" || !t) {
			console.info(`${B} ignoring go2rtc message that is not an object`);
			return;
		}
		let n = t;
		if (typeof n.type != "string") {
			console.info(`${B} ignoring go2rtc message with no "type"`);
			return;
		}
		let r = this.subscriptions.get(n.type);
		if (!r || r.size === 0) {
			console.info(`${B} unhandled go2rtc message type "${n.type}"`);
			return;
		}
		for (let e of [...r]) {
			if (this.finished) return;
			e(n);
		}
	}
	handleClose(e) {
		if (this.finished) return;
		let t = e?.code ?? 0, n = e?.reason ?? "";
		this.finished = !0, this.opened = !1, this.socket = null, this.subscriptions.clear(), this.outbound.length = 0, this.onClose(t, n);
	}
	handleError() {
		this.finished || (this.finished = !0, this.opened = !1, this.subscriptions.clear(), this.outbound.length = 0, this.releaseSocket(), this.onError());
	}
}, V = "[simpler-camera-card]", ft = [
	"avc1.640029",
	"avc1.64002A",
	"avc1.640033",
	"hvc1.1.6.L153.B0",
	"mp4a.40.2",
	"mp4a.40.5",
	"flac",
	"opus"
], pt = .5, mt = class {
	constructor(e = {}) {
		this.onPlaying = () => {}, this.onDead = () => {}, this.state = "idle", this.video = null, this.client = null, this.mediaSource = null, this.sourceBuffer = null, this.objectUrl = null, this.handshakeTimer = null, this.codecs = "", this.staged = [], this.stagedBytes = 0, this.playing = !1, this.lastTime = null, this.handleVideoError = () => {
			let e = this.video?.error;
			this.die("media-error", e ? `<video> error ${e.code}: ${e.message}` : void 0);
		}, this.handleTimeUpdate = () => this.checkPlaybackAdvanced(), this.handleSourceOpen = () => this.requestMseLane(), this.handleUpdateEnd = () => this.afterUpdate(), this.handleSourceBufferError = () => this.die("media-error", "SourceBuffer error"), this.options = e;
	}
	mount(e, t) {
		if (this.state !== "idle") {
			console.info(`${V} MSE player mount() ignored: player is ${this.state}`);
			return;
		}
		this.state = "live", this.video = e, e.addEventListener("error", this.handleVideoError), e.addEventListener("timeupdate", this.handleTimeUpdate), this.handshakeTimer = setTimeout(() => this.die("handshake-timeout"), ct);
		let n = this.options.mediaSourceImpl ?? globalThis.MediaSource;
		if (!n) {
			this.die("media-error", "MediaSource is unavailable in this browser");
			return;
		}
		let r = ht(n);
		if (r === "") {
			this.die("media-error", "no MSE codec offered by this browser is usable");
			return;
		}
		if (this.codecs = r, !this.attachMediaSource(n, e)) return;
		let i = new dt(t, { webSocketImpl: this.options.webSocketImpl });
		this.client = i, i.onBinary = (e) => this.handleSegment(e), i.onClose = (e, t) => this.die("ws-close", `code ${e}${t ? ` (${t})` : ""}`), i.onError = () => this.die("ws-error"), i.on("mse", (e) => this.openSourceBuffer(e)), i.on("error", (e) => this.die("ws-error", `go2rtc: ${String(e.value)}`)), i.connect();
	}
	destroy() {
		this.state = "finished", this.teardown();
	}
	attachMediaSource(e, t) {
		let n;
		try {
			n = new e();
		} catch (e) {
			return this.die("media-error", `MediaSource could not be created: ${H(e)}`), !1;
		}
		this.mediaSource = n, n.addEventListener("sourceopen", this.handleSourceOpen, { once: !0 });
		try {
			this.objectUrl = URL.createObjectURL(n), t.src = this.objectUrl;
		} catch (e) {
			return this.die("media-error", `MediaSource could not be attached: ${H(e)}`), !1;
		}
		return !0;
	}
	requestMseLane() {
		this.state === "live" && (this.objectUrl &&= (URL.revokeObjectURL(this.objectUrl), null), this.client?.send({
			type: "mse",
			value: this.codecs
		}));
	}
	openSourceBuffer(e) {
		if (this.state !== "live" || this.sourceBuffer) return;
		let t = typeof e.value == "string" ? e.value : "";
		if (t === "") {
			this.die("media-error", "go2rtc offered no MSE codec for this stream");
			return;
		}
		let n = this.mediaSource;
		if (!n || n.readyState !== "open") {
			this.die("media-error", "MediaSource closed before the MSE lane opened");
			return;
		}
		let r;
		try {
			r = n.addSourceBuffer(t), r.mode = "segments";
		} catch (e) {
			this.die("media-error", `addSourceBuffer("${t}") failed: ${H(e)}`);
			return;
		}
		r.addEventListener("updateend", this.handleUpdateEnd), r.addEventListener("error", this.handleSourceBufferError), this.sourceBuffer = r, this.startPlayback(), this.flushStaged();
	}
	handleSegment(e) {
		if (this.state !== "live") return;
		let t = new Uint8Array(e), n = this.sourceBuffer;
		if (!n || n.updating || this.staged.length > 0) {
			this.stage(t);
			return;
		}
		this.append(t);
	}
	stage(e) {
		this.staged.push(e), this.stagedBytes += e.byteLength, (this.staged.length > 200 || this.stagedBytes > 4194304) && (console.info(`${V} MSE staging queue overflowed (${this.staged.length} segments / ${this.stagedBytes} bytes): the SourceBuffer has stopped draining`), this.die("media-error", "staging queue overflow"));
	}
	flushStaged() {
		let e = this.sourceBuffer;
		if (this.state !== "live" || !e || e.updating || this.staged.length === 0) return;
		let t = this.staged, n = this.stagedBytes;
		if (this.staged = [], this.stagedBytes = 0, t.length === 1) {
			this.append(t[0]);
			return;
		}
		let r = new Uint8Array(n), i = 0;
		for (let e of t) r.set(e, i), i += e.byteLength;
		this.append(r);
	}
	append(e) {
		let t = this.sourceBuffer;
		if (t) try {
			t.appendBuffer(e);
		} catch (e) {
			console.info(`${V} appendBuffer failed:`, e), this.die("media-error", `appendBuffer failed: ${H(e)}`);
		}
	}
	afterUpdate() {
		if (this.state === "live") {
			if (this.staged.length > 0) {
				this.flushStaged();
				return;
			}
			this.runBufferHygiene();
		}
	}
	runBufferHygiene() {
		let e = this.sourceBuffer, t = this.video;
		if (!e || !t || e.updating) return;
		let n = e.buffered;
		if (!n || n.length === 0) return;
		let r = n.start(0), i = n.end(n.length - 1);
		if (this.playing) {
			let e = i - t.currentTime;
			if (e > 10) {
				console.info(`${V} ${e.toFixed(1)}s buffered ahead of playback (limit 10s): declaring the stream broken`), this.die("media-error", "buffered too far ahead of playback");
				return;
			}
			if (e > 2 && !t.seeking) {
				let n = i - pt;
				n > t.currentTime && (console.info(`${V} ${e.toFixed(1)}s behind the live edge: jumping to live`), t.currentTime = n);
			}
		}
		let a = t.currentTime - 5;
		if (a > r && this.mediaSource?.readyState === "open") try {
			e.remove(r, a);
		} catch (e) {
			console.info(`${V} back-buffer trim failed:`, e);
		}
	}
	startPlayback() {
		let e = this.video;
		if (!e) return;
		let t = e.play();
		!t || typeof t.catch != "function" || t.catch((t) => {
			this.state === "live" && (console.info(`${V} play() rejected, retrying muted:`, t), e.muted = !0, e.play()?.catch?.((e) => {
				this.state === "live" && console.info(`${V} muted play() also rejected:`, e);
			}));
		});
	}
	checkPlaybackAdvanced() {
		if (this.state !== "live" || !this.video) return;
		let e = this.video.currentTime, t = this.lastTime;
		this.lastTime = e, !(t === null || e <= t) && (this.playing || (this.playing = !0, this.clearHandshakeTimer(), console.info(`${V} MSE playback started`), this.onPlaying()));
	}
	die(e, t) {
		this.state !== "finished" && (this.state = "finished", console.info(`${V} MSE player died: ${e}${t ? ` — ${t}` : ""}`), this.teardown(), this.onDead(e));
	}
	teardown() {
		this.clearHandshakeTimer(), this.staged = [], this.stagedBytes = 0, this.client?.close(), this.client = null;
		let e = this.sourceBuffer;
		this.sourceBuffer = null;
		let t = this.mediaSource;
		this.mediaSource = null, e && (e.removeEventListener("updateend", this.handleUpdateEnd), e.removeEventListener("error", this.handleSourceBufferError)), t && (t.removeEventListener("sourceopen", this.handleSourceOpen), t.readyState === "open" && (U(() => e?.abort()), U(() => e && t.removeSourceBuffer(e)))), this.objectUrl &&= (U(() => URL.revokeObjectURL(this.objectUrl)), null);
		let n = this.video;
		this.video = null, n && (n.removeEventListener("error", this.handleVideoError), n.removeEventListener("timeupdate", this.handleTimeUpdate), U(() => {
			n.removeAttribute("src"), n.load();
		}));
	}
	clearHandshakeTimer() {
		this.handshakeTimer !== null && (clearTimeout(this.handshakeTimer), this.handshakeTimer = null);
	}
};
function ht(e) {
	return ft.filter((t) => {
		try {
			return e.isTypeSupported(`video/mp4; codecs="${t}"`);
		} catch {
			return !1;
		}
	}).join(",");
}
function H(e) {
	return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
function U(e) {
	try {
		e();
	} catch {}
}
//#endregion
//#region src/player/webrtc-player.ts
var W = "[simpler-camera-card]", gt = [], _t = class {
	constructor(e = {}) {
		this.onPlaying = () => {}, this.onDead = () => {}, this.state = "idle", this.video = null, this.client = null, this.pc = null, this.handshakeTimer = null, this.answerSeen = !1, this.remoteDescriptionApplied = !1, this.pendingCandidates = [], this.assembledStream = null, this.playbackRequested = !1, this.playing = !1, this.lastTime = null, this.handleVideoError = () => {
			let e = this.video?.error;
			this.die("media-error", e ? `<video> error ${e.code}: ${e.message}` : void 0);
		}, this.handleTimeUpdate = () => this.checkPlaybackAdvanced(), this.handleTrack = (e) => this.attachTrack(e), this.handleIceCandidate = (e) => this.sendLocalCandidate(e), this.handleConnectionStateChange = () => this.checkConnectionState("connectionState", this.pc?.connectionState), this.handleIceConnectionStateChange = () => this.checkConnectionState("iceConnectionState", this.pc?.iceConnectionState), this.options = e;
	}
	mount(e, t) {
		if (this.state !== "idle") {
			console.info(`${W} WebRTC player mount() ignored: player is ${this.state}`);
			return;
		}
		this.state = "live", this.video = e, e.addEventListener("error", this.handleVideoError), e.addEventListener("timeupdate", this.handleTimeUpdate), this.handshakeTimer = setTimeout(() => this.die("handshake-timeout"), ct);
		let n = this.options.peerConnectionImpl ?? globalThis.RTCPeerConnection;
		if (!n) {
			this.die("media-error", "WebRTC is unavailable in this browser");
			return;
		}
		if (!this.createPeerConnection(n)) return;
		let r = new dt(t, { webSocketImpl: this.options.webSocketImpl });
		this.client = r, r.onClose = (e, t) => this.die("ws-close", `code ${e}${t ? ` (${t})` : ""}`), r.onError = () => this.die("ws-error"), r.on("webrtc/answer", (e) => void this.applyAnswer(e)), r.on("webrtc/candidate", (e) => this.receiveRemoteCandidate(e)), r.on("error", (e) => this.die("ws-error", `go2rtc: ${String(e.value)}`)), r.connect(), this.sendOffer();
	}
	destroy() {
		this.state = "finished", this.teardown();
	}
	createPeerConnection(e) {
		let t;
		try {
			t = new e({ iceServers: [...gt] });
		} catch (e) {
			return this.die("media-error", `RTCPeerConnection could not be created: ${G(e)}`), !1;
		}
		this.pc = t, t.addEventListener("track", this.handleTrack), t.addEventListener("icecandidate", this.handleIceCandidate), t.addEventListener("connectionstatechange", this.handleConnectionStateChange), t.addEventListener("iceconnectionstatechange", this.handleIceConnectionStateChange);
		try {
			t.addTransceiver("video", { direction: "recvonly" }), t.addTransceiver("audio", { direction: "recvonly" });
		} catch (e) {
			return this.die("media-error", `addTransceiver failed: ${G(e)}`), !1;
		}
		return !0;
	}
	async sendOffer() {
		let e = this.pc;
		if (!e || this.state !== "live") return;
		let t;
		try {
			let n = await e.createOffer();
			if (this.state !== "live" || (await e.setLocalDescription(n), this.state !== "live")) return;
			t = e.localDescription?.sdp ?? n.sdp ?? "";
		} catch (e) {
			this.die("ws-error", `WebRTC offer could not be created: ${G(e)}`);
			return;
		}
		if (t === "") {
			this.die("ws-error", "WebRTC offer carried no SDP");
			return;
		}
		console.info(`${W} WebRTC offer sent (${t.length} bytes of SDP)`), this.client?.send({
			type: "webrtc/offer",
			value: t
		});
	}
	async applyAnswer(e) {
		if (this.state !== "live") return;
		let t = this.pc;
		if (!t) return;
		if (this.answerSeen) {
			console.info(`${W} ignoring a duplicate webrtc/answer`);
			return;
		}
		let n = typeof e.value == "string" ? e.value : "";
		if (n === "") {
			this.die("ws-error", "go2rtc sent a webrtc/answer with no SDP");
			return;
		}
		this.answerSeen = !0;
		try {
			await t.setRemoteDescription({
				type: "answer",
				sdp: n
			});
		} catch (e) {
			this.die("ws-error", `webrtc/answer rejected: ${G(e)}`);
			return;
		}
		this.state === "live" && (console.info(`${W} WebRTC answer applied`), this.remoteDescriptionApplied = !0, this.flushPendingCandidates());
	}
	receiveRemoteCandidate(e) {
		if (this.state !== "live") return;
		let t = typeof e.value == "string" ? e.value : "";
		if (t !== "") {
			if (!this.remoteDescriptionApplied) {
				if (this.pendingCandidates.length >= 64) {
					console.info(`${W} dropping a remote ICE candidate: buffer full`);
					return;
				}
				this.pendingCandidates.push(t);
				return;
			}
			this.addRemoteCandidate(t);
		}
	}
	flushPendingCandidates() {
		let e = this.pendingCandidates;
		this.pendingCandidates = [];
		for (let t of e) this.addRemoteCandidate(t);
	}
	async addRemoteCandidate(e) {
		if (this.state === "live") try {
			await this.pc?.addIceCandidate({
				candidate: e,
				sdpMid: "0"
			});
		} catch (e) {
			console.info(`${W} ignoring an unusable remote ICE candidate:`, e);
		}
	}
	sendLocalCandidate(e) {
		if (this.state !== "live") return;
		let t = e.candidate?.candidate;
		t && this.client?.send({
			type: "webrtc/candidate",
			value: t
		});
	}
	attachTrack(e) {
		if (this.state !== "live") return;
		let t = this.video;
		if (!t) return;
		let n = e.streams?.[0] ?? this.assemble(e.track);
		n && (t.srcObject !== n && (t.srcObject = n, console.info(`${W} WebRTC media attached (${e.track?.kind ?? "unknown"} track)`)), !this.playbackRequested && (this.playbackRequested = !0, this.startPlayback()));
	}
	assemble(e) {
		if (!e) return null;
		let t = globalThis.MediaStream;
		return t ? (this.assembledStream ||= new t(), this.assembledStream.addTrack(e), this.assembledStream) : (console.info(`${W} no MediaStream constructor: cannot attach a track without one`), null);
	}
	startPlayback() {
		let e = this.video;
		if (!e) return;
		let t = e.play();
		!t || typeof t.catch != "function" || t.catch((t) => {
			this.state === "live" && (console.info(`${W} play() rejected, retrying muted:`, t), e.muted = !0, e.play()?.catch?.((e) => {
				this.state === "live" && console.info(`${W} muted play() also rejected:`, e);
			}));
		});
	}
	checkPlaybackAdvanced() {
		if (this.state !== "live" || !this.video) return;
		let e = this.video.currentTime, t = this.lastTime;
		this.lastTime = e, !(t === null || e <= t) && (this.playing || (this.playing = !0, this.clearHandshakeTimer(), console.info(`${W} WebRTC playback started`), this.onPlaying()));
	}
	checkConnectionState(e, t) {
		if (!(this.state !== "live" || !t)) {
			if (t === "failed") {
				this.die("ws-error", `${e} failed`);
				return;
			}
			if (t === "disconnected") {
				console.info(`${W} WebRTC ${e} disconnected — not fatal; the watchdog convicts if frames stop`);
				return;
			}
			console.info(`${W} WebRTC ${e}: ${t}`);
		}
	}
	die(e, t) {
		this.state !== "finished" && (this.state = "finished", console.info(`${W} WebRTC player died: ${e}${t ? ` — ${t}` : ""}`), this.teardown(), this.onDead(e));
	}
	teardown() {
		this.clearHandshakeTimer(), this.pendingCandidates = [], this.client?.close(), this.client = null;
		let e = this.pc;
		this.pc = null, e && (e.removeEventListener("track", this.handleTrack), e.removeEventListener("icecandidate", this.handleIceCandidate), e.removeEventListener("connectionstatechange", this.handleConnectionStateChange), e.removeEventListener("iceconnectionstatechange", this.handleIceConnectionStateChange), K(() => {
			for (let t of e.getTransceivers?.() ?? []) K(() => t.stop?.());
		}), K(() => e.close())), this.assembledStream = null;
		let t = this.video;
		this.video = null, t && (t.removeEventListener("error", this.handleVideoError), t.removeEventListener("timeupdate", this.handleTimeUpdate), K(() => {
			t.srcObject = null, t.removeAttribute("src"), t.load();
		}));
	}
	clearHandshakeTimer() {
		this.handshakeTimer !== null && (clearTimeout(this.handshakeTimer), this.handshakeTimer = null);
	}
};
function G(e) {
	return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
function K(e) {
	try {
		e();
	} catch {}
}
//#endregion
//#region src/reliability/retry.ts
var vt = {
	setTimeout: (e, t) => globalThis.setTimeout(e, t),
	clearTimeout: (e) => globalThis.clearTimeout(e),
	setInterval: (e, t) => globalThis.setInterval(e, t),
	clearInterval: (e) => globalThis.clearInterval(e)
}, yt = class {
	constructor(e = {}) {
		this.failures = 0, this.baseMs = e.baseMs ?? 5e3, this.factor = e.factor ?? 2, this.capMs = e.capMs ?? 6e5, this.jitterMin = e.jitterMin ?? .5, this.jitterMax = e.jitterMax ?? 1, this.random = e.random ?? Math.random;
	}
	get attempts() {
		return this.failures;
	}
	peek() {
		return Math.min(this.baseMs * this.factor ** +this.failures, this.capMs);
	}
	next() {
		let e = this.peek();
		this.failures += 1;
		let t = this.jitterMin + this.random() * (this.jitterMax - this.jitterMin);
		return Math.round(e * t);
	}
	reset() {
		this.failures = 0;
	}
}, bt = class {
	constructor(e = vt) {
		this.handle = null, this.callback = null, this.timers = e;
	}
	get pending() {
		return this.callback !== null;
	}
	get delayMs() {
		return this.pending ? this.scheduledDelayMs : void 0;
	}
	schedule(e, t) {
		this.cancel(), this.callback = t, this.scheduledDelayMs = e, this.handle = this.timers.setTimeout(() => this.fire(), e);
	}
	advance() {
		return this.pending ? (this.fire(), !0) : !1;
	}
	cancel() {
		this.handle !== null && (this.timers.clearTimeout(this.handle), this.handle = null), this.callback = null, this.scheduledDelayMs = void 0;
	}
	fire() {
		let e = this.callback;
		this.cancel(), e?.();
	}
};
function xt(e) {
	let t = e, n = t.requestVideoFrameCallback, r = t.cancelVideoFrameCallback;
	return typeof n == "function" ? {
		request: (t) => n.call(e, t),
		cancel: (t) => {
			typeof r == "function" && r.call(e, t);
		}
	} : null;
}
var St = class {
	constructor(e) {
		this.video = null, this.armedFlag = !1, this.stalledFlag = !1, this.destroyed = !1, this.stallHandle = null, this.pollHandle = null, this.frames = null, this.frameHandle = null, this.lastCurrentTime = 0, this.onProgressEvent = () => this.checkProgress(), this.onStall = e.onStall, this.isPlaybackExpected = e.isPlaybackExpected ?? (() => !0), this.timeoutMs = e.timeoutMs ?? 1e4, this.pollIntervalMs = e.pollIntervalMs ?? 1e3, this.timers = e.timers ?? vt;
	}
	get armed() {
		return this.armedFlag;
	}
	get stalled() {
		return this.stalledFlag;
	}
	get usingFrameCallbacks() {
		return this.frames !== null;
	}
	attach(e) {
		if (this.destroyed || this.video === e) return;
		let t = this.armedFlag;
		this.stopObserving(), this.video = e, t && this.startObserving();
	}
	arm() {
		this.destroyed || this.armedFlag || (this.armedFlag = !0, this.stalledFlag = !1, this.startObserving());
	}
	disarm() {
		this.armedFlag = !1, this.stopObserving();
	}
	reset() {
		this.stalledFlag = !1, this.armedFlag && (this.stopObserving(), this.startObserving());
	}
	detach() {
		this.disarm(), this.stalledFlag = !1, this.video = null;
	}
	destroy() {
		this.detach(), this.destroyed = !0;
	}
	startObserving() {
		let e = this.video;
		if (!(!e || !this.armedFlag || this.destroyed)) {
			if (this.lastCurrentTime = e.currentTime, this.armStallTimer(), this.frames = xt(e), this.frames) {
				this.requestFrame();
				return;
			}
			e.addEventListener("timeupdate", this.onProgressEvent), this.pollHandle = this.timers.setInterval(this.onProgressEvent, this.pollIntervalMs);
		}
	}
	stopObserving() {
		this.stallHandle !== null && (this.timers.clearTimeout(this.stallHandle), this.stallHandle = null), this.pollHandle !== null && (this.timers.clearInterval(this.pollHandle), this.pollHandle = null), this.frames && this.frameHandle !== null && this.frames.cancel(this.frameHandle), this.frameHandle = null, this.frames = null, this.video?.removeEventListener("timeupdate", this.onProgressEvent);
	}
	requestFrame() {
		let e = this.frames;
		!e || !this.armedFlag || this.stalledFlag || this.destroyed || (this.frameHandle = e.request(() => {
			this.frameHandle = null, this.onFramePresented();
		}));
	}
	onFramePresented() {
		!this.armedFlag || this.stalledFlag || this.destroyed || (this.video && (this.lastCurrentTime = this.video.currentTime), this.armStallTimer(), this.requestFrame());
	}
	checkProgress() {
		let e = this.video;
		!e || !this.armedFlag || this.stalledFlag || this.destroyed || e.currentTime !== this.lastCurrentTime && (this.lastCurrentTime = e.currentTime, this.armStallTimer());
	}
	armStallTimer() {
		this.stallHandle !== null && this.timers.clearTimeout(this.stallHandle), this.stallHandle = this.timers.setTimeout(() => this.onStallTimeout(), this.timeoutMs);
	}
	onStallTimeout() {
		if (this.stallHandle = null, !(!this.armedFlag || this.stalledFlag || this.destroyed)) {
			if (!this.playbackIsExpected()) {
				this.armStallTimer();
				return;
			}
			this.stalledFlag = !0, this.armedFlag = !1, this.stopObserving(), this.onStall();
		}
	}
	playbackIsExpected() {
		let e = this.video;
		return !e || !this.isPlaybackExpected() ? !1 : !e.paused && !e.seeking && !e.ended;
	}
}, q = "[simpler-camera-card]", Ct = class {
	constructor(e) {
		this.onStateChange = () => {}, this.currentState = "idle", this.started = !1, this.suspended = !1, this.player = null, this.generation = 0, this.tier1Attempts = 0, this.remountAttempts = 0, this.pending = {}, this.downSince = null, this.deps = e, this.log = e.logger ?? console, this.now = e.now ?? (() => Date.now()), this.reloadPage = e.reloadPage ?? (() => location.reload());
		let t = e.timers ?? vt;
		this.retryTimer = new bt(t), this.hiddenTimer = new bt(t), this.escapeTimer = new bt(t), this.backoff = new yt({
			random: e.random,
			...e.backoff
		});
		let n = {
			onStall: () => this.handleStall(),
			isPlaybackExpected: () => this.started && !this.suspended && this.currentState === "playing",
			timers: t
		};
		this.watchdog = e.createWatchdog ? e.createWatchdog(n) : new St(n);
	}
	get state() {
		return this.currentState;
	}
	start() {
		this.started || (this.started = !0, this.suspended = !1, this.tier1Attempts = 0, this.remountAttempts = 0, this.backoff.reset(), this.pending = {}, this.downSince = null, this.markDown(), this.beginAttempt());
	}
	stop() {
		this.hiddenTimer.cancel(), this.retryTimer.cancel(), this.escapeTimer.cancel(), this.teardownPlayer(), this.watchdog.disarm(), this.watchdog.detach(), this.started = !1, this.suspended = !1, this.tier1Attempts = 0, this.remountAttempts = 0, this.backoff.reset(), this.pending = {}, this.downSince = null, this.currentState !== "idle" && this.setState("idle");
	}
	notifyExternalEvent(e) {
		switch (e) {
			case "hass-reconnected":
			case "page-resumed":
				this.handleConnectivityEvent(e);
				break;
			case "visibility-hidden":
				this.handleHidden();
				break;
			case "visibility-visible": this.handleVisible();
		}
	}
	beginAttempt() {
		if (!this.started || this.suspended) return;
		let e = ++this.generation;
		this.setState("connecting", {
			reason: this.pending.reason,
			attempt: this.pending.attempt,
			downForMs: this.downForMs()
		});
		let t = this.deps.getHass();
		if (!t) {
			this.handleDeath("ws-error", "Home Assistant is not available yet.");
			return;
		}
		let n = this.deps.getVideo();
		if (!n) {
			this.handleDeath("media-error", "The video element is not ready yet.");
			return;
		}
		this.watchdog.attach(n);
		let r = this.deps.getConfig();
		this.deps.endpoint.resolveSignedWsUrl(t, r).then((t) => {
			this.isCurrent(e) && this.mountPlayer(r, n, t, e);
		}, (t) => {
			this.isCurrent(e) && this.handleDeath("ws-error", J(t));
		});
	}
	mountPlayer(e, t, n, r) {
		let i;
		try {
			i = this.deps.createPlayer(e.transport);
		} catch (e) {
			this.handleDeath("media-error", J(e));
			return;
		}
		this.player = i, i.onPlaying = () => {
			this.isCurrent(r) && this.handlePlaying();
		}, i.onDead = (e) => {
			this.isCurrent(r) && this.handleDeath(e);
		};
		try {
			i.mount(t, n);
		} catch (e) {
			this.handleDeath("media-error", J(e));
		}
	}
	handlePlaying() {
		this.currentState !== "playing" && (this.retryTimer.cancel(), this.escapeTimer.cancel(), this.tier1Attempts = 0, this.remountAttempts = 0, this.backoff.reset(), this.pending = {}, this.downSince = null, this.watchdog.reset(), this.setState("playing"), this.watchdog.arm());
	}
	handleDeath(e, t) {
		if (!this.started || this.suspended) return;
		this.teardownPlayer(), this.watchdog.disarm(), this.watchdog.reset(), this.markDown();
		let n = this.downForMs(), r, i, a;
		this.tier1Attempts < 3 ? (this.tier1Attempts += 1, r = "retrying", i = this.tier1Attempts, a = tt) : (this.remountAttempts += 1, r = "remounting", i = this.remountAttempts, a = this.backoff.next()), this.log.info(`${q} stream died: ${e}, ${r === "retrying" ? "tier-1 retry" : "tier-2 remount"} ${i} in ${a} ms (down for ${Math.round(n / 1e3)} s)` + (t ? `: ${t}` : "")), this.pending = {
			reason: e,
			attempt: i,
			message: t
		}, this.setState(r, {
			reason: e,
			attempt: i,
			delayMs: a,
			downForMs: n,
			message: t
		}), this.retryTimer.schedule(a, () => this.beginAttempt());
	}
	handleStall() {
		this.handleDeath("stall");
	}
	teardownPlayer() {
		this.generation += 1;
		let e = this.player;
		if (this.player = null, e) {
			e.onPlaying = () => {}, e.onDead = () => {};
			try {
				e.destroy();
			} catch (e) {
				this.log.info(`${q} player teardown threw: ${J(e)}`);
			}
		}
	}
	isCurrent(e) {
		return this.started && !this.suspended && e === this.generation;
	}
	handleConnectivityEvent(e) {
		if (!(!this.started || this.suspended)) {
			if (this.currentState === "playing") {
				this.log.info(`${q} ${e} while playing; letting the watchdog verify frames`);
				return;
			}
			this.backoff.reset(), this.retryTimer.pending && (this.log.info(`${q} ${e}: retrying immediately`), this.pending = {
				...this.pending,
				reason: e
			}, this.retryTimer.advance());
		}
	}
	handleHidden() {
		!this.started || this.suspended || this.hiddenTimer.pending || this.hiddenTimer.schedule(lt, () => this.suspend());
	}
	handleVisible() {
		this.hiddenTimer.cancel(), !(!this.started || !this.suspended) && (this.suspended = !1, this.tier1Attempts = 0, this.remountAttempts = 0, this.backoff.reset(), this.pending = {}, this.markDown(), this.beginAttempt());
	}
	suspend() {
		!this.started || this.suspended || (this.suspended = !0, this.retryTimer.cancel(), this.escapeTimer.cancel(), this.teardownPlayer(), this.watchdog.disarm(), this.watchdog.reset(), this.downSince = null, this.pending = {}, this.log.info(`${q} dashboard hidden; stream torn down until it is visible again`), this.setState("idle", { message: "Paused while the dashboard is hidden." }));
	}
	markDown() {
		if (this.downSince !== null) return;
		this.downSince = this.now();
		let e = this.deps.getConfig().reload_after_minutes_down ?? 0;
		!Number.isFinite(e) || e <= 0 || this.escapeTimer.schedule(e * 6e4, () => this.triggerReload(e));
	}
	triggerReload(e) {
		this.log.info(`${q} stream down for ${e} minute(s); reloading the page (escape hatch)`), this.reloadPage();
	}
	downForMs() {
		return this.downSince === null ? 0 : Math.max(0, this.now() - this.downSince);
	}
	setState(e, t) {
		this.currentState = e, this.onStateChange(e, t);
	}
};
function J(e) {
	return e instanceof Error ? e.message : typeof e == "string" ? e : e && typeof e == "object" && "message" in e ? String(e.message) : String(e);
}
//#endregion
//#region \0@oxc-project+runtime@0.144.0/helpers/esm/decorate.js
function Y(e, t, n, r) {
	var i = arguments.length, a = i < 3 ? t : r === null ? r = Object.getOwnPropertyDescriptor(t, n) : r, o;
	if (typeof Reflect == "object" && typeof Reflect.decorate == "function") a = Reflect.decorate(e, t, n, r);
	else for (var s = e.length - 1; s >= 0; s--) (o = e[s]) && (a = (i < 3 ? o(a) : i > 3 ? o(t, n, a) : o(t, n)) || a);
	return i > 3 && a && Object.defineProperty(t, n, a), a;
}
//#endregion
//#region src/card.ts
var wt = "[simpler-camera-card]", X = class extends Error {
	constructor(e) {
		super(e), this.name = "ConfigError";
	}
}, Tt = /^[a-z_]+\.[a-z0-9_]+$/, Et = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/;
function Dt(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function Z(e) {
	return e.map((e) => `"${e}"`).join(", ");
}
function Q(e, t, n) {
	if (e === void 0) return n;
	if (!Dt(e)) throw new X(`"${t}" must be an action object, e.g. { action: more-info }.`);
	let r = e.action;
	if (typeof r != "string" || !R.includes(r)) throw new X(`"${t}.action" must be one of ${Z(R)} (got ${JSON.stringify(r)}).`);
	return e;
}
function Ot(e) {
	if (e === void 0) return z.aspectRatio;
	if (typeof e == "number") {
		if (!Number.isFinite(e) || e <= 0) throw new X(`"aspect_ratio" must be a positive number (got ${e}).`);
		return String(e);
	}
	if (typeof e == "string") {
		let t = Et.exec(e);
		if (t) {
			let [, e, n] = t;
			if (Number(e) > 0 && Number(n) > 0) return `${e} / ${n}`;
		} else {
			let t = Number(e.trim());
			if (Number.isFinite(t) && t > 0) return String(t);
		}
	}
	throw new X(`"aspect_ratio" must look like "16:9" or be a positive number (got ${JSON.stringify(e)}).`);
}
function kt(e) {
	if (!Dt(e)) throw new X("Invalid configuration: expected a YAML mapping.");
	let t = e.camera;
	if (t == null || t === "") throw new X("\"camera\" is required, e.g. camera: camera.front_yard.");
	if (typeof t != "string" || !Tt.test(t)) throw new X(`"camera" must be an entity id like "camera.front_yard" (got ${JSON.stringify(t)}).`);
	if (!t.startsWith("camera.")) throw new X(`"camera" must be a camera entity (got "${t}").`);
	if (e.stream !== void 0 && (typeof e.stream != "string" || e.stream.trim() === "")) throw new X(`"stream" must be a non-empty go2rtc stream name, e.g. front_yard_sub (got ${JSON.stringify(e.stream)}).`);
	let n = e.transport ?? z.transport;
	if (typeof n != "string" || !Qe.includes(n)) throw new X(`"transport" must be one of ${Z(Qe)} (got ${JSON.stringify(e.transport)}).`);
	let r = e.overlay ?? z.overlay;
	if (typeof r != "string" || !$e.includes(r)) throw new X(`"overlay" must be one of ${Z($e)} (got ${JSON.stringify(e.overlay)}).`);
	if (e.overlay_text !== void 0 && typeof e.overlay_text != "string") throw new X("\"overlay_text\" must be a string.");
	if (r === "custom" && (e.overlay_text === void 0 || e.overlay_text === "")) throw new X("\"overlay: custom\" requires \"overlay_text\" to be set.");
	let i = e.reload_after_minutes_down ?? z.reloadAfterMinutesDown;
	if (typeof i != "number" || !Number.isFinite(i) || i < 0) throw new X(`"reload_after_minutes_down" must be a number of minutes >= 0, or 0 to disable (got ${JSON.stringify(e.reload_after_minutes_down)}).`);
	return {
		...e,
		type: typeof e.type == "string" ? e.type : L,
		camera: t,
		transport: n,
		overlay: r,
		tap_action: Q(e.tap_action, "tap_action", z.tapAction),
		hold_action: Q(e.hold_action, "hold_action", z.holdAction),
		double_tap_action: Q(e.double_tap_action, "double_tap_action", z.doubleTapAction),
		aspect_ratio: Ot(e.aspect_ratio),
		reload_after_minutes_down: i
	};
}
function At() {
	let e = document.createElement("video");
	e.className = "video", e.muted = !0;
	for (let t of [
		"muted",
		"playsinline",
		"autoplay",
		"disablepictureinpicture"
	]) e.setAttribute(t, "");
	return e;
}
var $ = class extends M {
	constructor(...e) {
		super(...e), this._streamState = "idle", this._video = At(), this._actions = new Be({
			getConfig: () => this._config,
			getEventTarget: () => this
		}), this._startScheduled = !1, this._onVisibilityChange = () => {
			this._supervisor?.notifyExternalEvent(document.visibilityState === "hidden" ? "visibility-hidden" : "visibility-visible");
		}, this._onPageResumed = () => {
			this._supervisor?.notifyExternalEvent("page-resumed");
		};
	}
	get _endpoint() {
		return this.supervisorOverrides?.endpoint ?? Xe;
	}
	set hass(e) {
		let t = this._hass;
		this._hass = e, t?.connected === !1 && e?.connected === !0 && this._supervisor?.notifyExternalEvent("hass-reconnected"), this._maybeStart(), this._config && (t?.states?.[this._config.camera] !== e?.states?.[this._config.camera] || t?.connected !== e?.connected) && this.requestUpdate("hass", t);
	}
	get hass() {
		return this._hass;
	}
	setConfig(e) {
		let t = kt(e), n = this._config;
		this._config = t, n && (this._stopSupervisor(), this._posterUrl = void 0), this._maybeStart();
	}
	connectedCallback() {
		super.connectedCallback(), document.addEventListener("visibilitychange", this._onVisibilityChange), document.addEventListener("resume", this._onPageResumed), window.addEventListener("pageshow", this._onPageResumed), window.addEventListener("online", this._onPageResumed), this.updateComplete.then(() => {
			this.isConnected && this._syncActionTarget();
		}), this._maybeStart();
	}
	disconnectedCallback() {
		document.removeEventListener("visibilitychange", this._onVisibilityChange), document.removeEventListener("resume", this._onPageResumed), window.removeEventListener("pageshow", this._onPageResumed), window.removeEventListener("online", this._onPageResumed), this._actions.detach(), this._stopSupervisor(), super.disconnectedCallback();
	}
	updated(e) {
		super.updated(e), this._syncActionTarget();
	}
	_syncActionTarget() {
		let e = this.shadowRoot?.querySelector(".container") ?? null;
		e !== this._actions.target && (e ? this._actions.attach(e) : this._actions.detach());
	}
	_maybeStart() {
		this._supervisor || this._startScheduled || !this.isConnected || !this._config || !this._hass || (this._startScheduled = !0, this.updateComplete.then(() => {
			this._startScheduled = !1, !(this._supervisor || !this.isConnected || !this._config || !this._hass) && this._startSupervisor(this._config);
		}));
	}
	_startSupervisor(e) {
		let t = new Ct({
			createPlayer: (e) => e === "webrtc" ? new _t() : new mt(),
			endpoint: Xe,
			getHass: () => this._hass,
			getVideo: () => this._video,
			getConfig: () => this._config ?? e,
			...this.supervisorOverrides
		});
		t.onStateChange = (e, t) => this._onStreamState(e, t), this._supervisor = t, t.start();
	}
	_stopSupervisor() {
		this._supervisor?.stop(), this._supervisor = void 0, this._stopPosterRefresh(), this._streamState = "idle", this._streamDetail = void 0;
	}
	_onStreamState(e, t) {
		if (this._streamState = e, this._streamDetail = t, e === "playing") {
			this._stopPosterRefresh();
			return;
		}
		if (e === "idle") {
			this._stopPosterRefresh();
			return;
		}
		this._refreshPoster(), this._startPosterRefresh();
	}
	_startPosterRefresh() {
		this._posterTimer === void 0 && (this._posterTimer = setInterval(() => {
			this._refreshPoster();
		}, ut));
	}
	_stopPosterRefresh() {
		this._posterTimer !== void 0 && (clearInterval(this._posterTimer), this._posterTimer = void 0);
	}
	async _refreshPoster() {
		let e = this._hass, t = this._config;
		if (!(!e || !t)) try {
			let n = await this._endpoint.resolvePosterUrl(e, t);
			n && (this._posterUrl = n);
		} catch (e) {
			console.info(`${wt} poster refresh failed:`, e);
		}
	}
	getCardSize() {
		return 6;
	}
	static getGridOptions() {
		return {
			columns: 12,
			rows: 6,
			min_columns: 6,
			min_rows: 3
		};
	}
	static getStubConfig(e) {
		let t = Object.keys(e?.states ?? {});
		return {
			type: L,
			camera: t.find((t) => t.startsWith("camera.") && !!e?.states[t]?.attributes?.camera_name) ?? t.find((e) => e.startsWith("camera.")) ?? "camera.front_yard"
		};
	}
	render() {
		let e = this._config;
		if (!e) return T;
		let t = this._streamState === "playing", n = this._hass?.states?.[e.camera], r = t ? void 0 : this._posterUrl ?? n?.attributes?.entity_picture, i = this._overlayText(e, n?.attributes?.friendly_name), a = t ? void 0 : this._statusText(!!n), o = ze(e), s = n?.attributes?.friendly_name ?? e.camera;
		return C`
      <ha-card>
        <div
          class="container${o ? " interactive" : ""}"
          style="aspect-ratio: ${e.aspect_ratio};"
          role=${o ? "button" : T}
          tabindex=${o ? "0" : T}
          aria-label=${o ? s : T}
        >
          ${r ? C`<img class="poster" src=${r} alt="" aria-hidden="true" />` : T}
          ${this._video} ${i ? C`<div class="overlay">${i}</div>` : T}
          ${a ? C`<div class="status">${a}</div>` : T}
        </div>
      </ha-card>
    `;
	}
	_overlayText(e, t) {
		switch (e.overlay) {
			case "name": return t ?? e.camera;
			case "custom": return e.overlay_text;
			default: return;
		}
	}
	_statusText(e) {
		if (!this._hass) return "Waiting for Home Assistant…";
		if (!e) return `Entity ${this._config?.camera} not found`;
		let t = this._streamDetail;
		switch (this._streamState) {
			case "playing": return;
			case "connecting": return Mt("Connecting…", t?.message);
			case "retrying":
			case "remounting": return Mt(`Reconnecting${jt(t?.delayMs)}…`, t?.message);
			default: return t?.message ?? "Not connected";
		}
	}
	static {
		this.styles = o`
    :host {
      display: block;
    }

    ha-card {
      overflow: hidden;
      position: relative;
      height: 100%;
    }

    .container {
      position: relative;
      width: 100%;
      background: #000;
      /* aspect-ratio is set inline from config; 16 / 9 by default. */
    }

    /*
     * Only present when tap_action is not "none". touch-action: manipulation
     * drops the browser's own double-tap-to-zoom (and the ~300 ms click delay
     * that comes with it) without disabling the scroll that a dashboard needs;
     * disabling selection stops a hold from turning into a text/image selection
     * or an iOS callout on top of the gesture.
     */
    .container.interactive {
      cursor: pointer;
      touch-action: manipulation;
      -webkit-user-select: none;
      user-select: none;
    }

    /* The container is focusable when interactive, so it needs a focus ring. */
    .container.interactive:focus-visible {
      outline: 2px solid var(--primary-color, #03a9f4);
      outline-offset: -2px;
    }

    .poster,
    .video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      /*
       * The gesture surface is the container, full stop. Making the media layers
       * transparent to pointers keeps a press off the browser's own image/video
       * affordances (drag-to-save, media context menus) — the events would have
       * bubbled up anyway, but from a target we do not control.
       */
      pointer-events: none;
    }

    /*
     * Dimmed while the live view is not up, so a blip degrades gracefully. It
     * sits above the <video> deliberately: a dying stream can leave a frozen
     * frame on the element, and a stale live frame is more misleading than an
     * honestly dimmed snapshot. It is only rendered while not playing.
     */
    .poster {
      filter: brightness(0.6);
      z-index: 1;
    }

    .overlay {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 16px 8px 6px;
      color: #fff;
      font-size: 0.95em;
      font-weight: 500;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
      background: linear-gradient(to top, rgba(0, 0, 0, 0.55), transparent);
      pointer-events: none;
    }

    .status {
      position: absolute;
      z-index: 2;
      top: 8px;
      right: 8px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      font-size: 0.75em;
      line-height: 1.6;
      pointer-events: none;
    }
  `;
	}
};
Y([N()], $.prototype, "_config", void 0), Y([N()], $.prototype, "_streamState", void 0), Y([N()], $.prototype, "_streamDetail", void 0), Y([N()], $.prototype, "_posterUrl", void 0);
function jt(e) {
	return typeof e != "number" || !Number.isFinite(e) || e <= 0 ? "" : e < 1e3 ? " shortly" : ` in ${Math.round(e / 1e3)} s`;
}
function Mt(e, t) {
	return t ? `${e} — ${t}` : e;
}
customElements.get("simpler-camera-card") || customElements.define(I, $);
//#endregion
//#region src/index.ts
var Nt = "0.1.1";
window.customCards = window.customCards ?? [], window.customCards.some((e) => e.type === "simpler-camera-card") || window.customCards.push({
	type: I,
	name: "Simpler Camera Card",
	description: "Single-camera Frigate live view via go2rtc, built to recover from network blips on long-running dashboards.",
	preview: !1,
	documentationURL: "https://git.bishopdynamics.com/claude/simpler-camera-card"
}), console.info(`%c SIMPLER-CAMERA-CARD %c v${Nt} `, "color: white; background: #039be5; font-weight: 700;", "color: #039be5; background: white; font-weight: 700;");
//#endregion
export { R as ACTION_NAMES, I as CARD_TAG, L as CARD_TYPE, Nt as CARD_VERSION, z as CONFIG_DEFAULTS, ct as HANDSHAKE_TIMEOUT_MS, lt as HIDDEN_TEARDOWN_GRACE_MS, $e as OVERLAY_MODES, ut as POSTER_REFRESH_INTERVAL_MS, nt as REMOUNT_BACKOFF_BASE_MS, it as REMOUNT_BACKOFF_CAP_MS, rt as REMOUNT_BACKOFF_FACTOR, ot as REMOUNT_BACKOFF_JITTER_MAX, at as REMOUNT_BACKOFF_JITTER_MIN, $ as SimplerCameraCard, et as TIER1_MAX_RETRIES, tt as TIER1_RETRY_DELAY_MS, Qe as TRANSPORTS, st as WATCHDOG_STALL_TIMEOUT_MS, kt as normalizeConfig };

//# sourceMappingURL=simpler-camera-card.js.map