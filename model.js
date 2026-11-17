export const uid = () => crypto.randomUUID();

const pad = n => String(n).padStart(2, '0');
export const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoDate(new Date());

export const labels = {
    invoiceTitle: 'INVOICE',
    laborTitle: 'Work & equipment',
    expensesTitle: 'Reimbursable expenses',
    totalTitle: 'Total amount due',
    paymentTitle: 'Payment details',
    receiptsTitle: 'Receipt proof'
};

/* Receipt status: pending = not reviewed yet, verified = OK,
   check = keep it, but someone must confirm it is a work expense,
   excluded = keep the record, never bill it. */
export const STATUS = {
    pending: 'To review',
    verified: 'Looks right',
    check: 'Flagged',
    excluded: 'Not billed'
};
export const isBillable = r => r.status === 'verified' || r.status === 'check';

// ---- Billing periods -------------------------------------------------------
export function monthBounds(month) {            // '2026-11' -> first and last day
    const [y, m] = month.split('-').map(Number);
    return { start: `${y}-${pad(m)}-01`, end: isoDate(new Date(y, m, 0)) };
}
export const shiftMonth = (month, by) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + by, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
export const compact = iso => String(iso || '').replaceAll('-', '');   // 2026-11-30 -> 20261130

/** Next day-10 deadline for a Korean tax invoice issued for this period. */
export function taxInvoiceDeadline(periodEnd) {
    const [y, m] = periodEnd.split('-').map(Number);
    return isoDate(new Date(y, m, 10));
}

export function newProject() {
    const baseToday = today();
    const autoId = `WS-${baseToday.replaceAll('-', '')}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

    return {
        id: uid(),
        updatedAt: Date.now(),
        formatId: 'generic',
        project: {
            projectTitle: '',
            clientName: '',
            clientAddress: '',
            periodMode: 'range',          // 'range' = shoot dates, 'month' = calendar month
            month: baseToday.slice(0, 7),
            shootStart: baseToday,
            shootEnd: baseToday,
            invoiceDate: baseToday,
            termsPreset: 'due_receipt',
            dueDate: baseToday,
            defaultInvoiceNumber: autoId,
            invoiceNumber: '',
            sequence: 1,
            location: '',
            currency: 'KRW',
            notes: 'Thank you for making it happen.',
            taxType: 'vat',               // 'vat' (+ added), 'withholding' (- deducted), 'none'
            taxRate: 10,
            vatOnExpenses: false
        },
        contractor: {
            name: '',
            role: '',
            entityType: 'freelancer',     // used by crew formats: freelancer | business | business_simplified
            email: '',
            phone: '',
            address: '',
            taxId: '',
            bankName: '',
            accountHolder: '',
            accountNumber: '',
            paymentTerms: 'Payment due upon receipt.',
            footer: '',
            logo: ''
        },
        labor: [],
        expenses: [],
        review: null,
        invoice: {
            templateId: 'production',
            accent: '#a8c3d0',
            labels: { ...labels },
            options: {
                showBankInfo: true,
                showVat: true,
                showReceiptGallery: true,
                showExpenseCategories: true,
                showNotes: true,
                bilingualLabels: false
            }
        }
    };
}

/** Fill in fields added after a project was first saved. */
export function upgradeProject(p) {
    const base = newProject();
    p.formatId ||= 'generic';
    p.project = { ...base.project, ...p.project };
    p.contractor = { ...base.contractor, ...p.contractor };
    p.invoice = { ...base.invoice, ...p.invoice, options: { ...base.invoice.options, ...p.invoice?.options } };
    p.review ??= null;
    p.labor ||= [];
    p.expenses = (p.expenses || []).map(newExpense);
    return p;
}

export function newExpense(r = {}) {
    const status = r.status || (r.verified ? 'verified' : 'pending');
    return {
        id: r.id || uid(),
        receiptId: r.receiptId ?? null,
        source: r.source || (r.receiptId ? 'receipt' : 'manual'),   // receipt | hipass | manual
        date: r.date || '',
        time: r.time || '',
        vendor: r.vendor || '',
        location: r.location || '',
        total: r.total ?? '',
        vat: r.vat ?? 0,
        currency: r.currency || '',
        category: r.category || '',
        paidBy: r.paidBy || '',
        shootDay: r.shootDay || '',
        notes: r.notes || '',
        route: r.route || '',
        balanceAfter: r.balanceAfter ?? '',
        warning: r.warning || '',
        status
    };
}

export const precision = currency => currency === 'KRW' ? 0 : 2;

export const round = (n, currency) =>
    Math.round((Number(n) + Number.EPSILON) * 10 ** precision(currency)) / 10 ** precision(currency);

export const money = (n, currency = 'KRW') =>
    new Intl.NumberFormat(currency === 'KRW' ? 'ko-KR' : 'en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: precision(currency)
    }).format(n);

export const byDateTime = (a, b) => `${a.date} ${a.time || '99:99'}`.localeCompare(`${b.date} ${b.time || '99:99'}`);

export function totals(s) {
    const c = s.project.currency;
    const line = r => round(r.quantity * r.rate, c);
    const labor = round(s.labor.reduce((n, r) => n + line(r), 0), c);
    const taxable = round(s.labor.filter(r => r.taxable).reduce((n, r) => n + line(r), 0), c);
    const billable = s.expenses.filter(isBillable);
    const expenses = round(billable.reduce((n, r) => n + (Number(r.total) || 0), 0), c);

    const mode = s.project.taxType || 'vat';
    const isWithholding = mode === 'withholding';
    const rate = mode === 'none' ? 0 : Number(s.project.taxRate) || 0;
    // Withholding applies to fees only. VAT can also apply to reimbursed expenses when the client bills it that way.
    const expenseTaxBase = !isWithholding && s.project.vatOnExpenses ? expenses : 0;
    const laborTax = round(taxable * rate / 100, c);
    const expenseTax = round(expenseTaxBase * rate / 100, c);
    const tax = round(laborTax + expenseTax, c);
    const total = round(isWithholding ? (labor - tax + expenses) : (labor + expenses + tax), c);

    const categories = {};
    for (const r of billable) {
        const k = r.category || 'Other';
        categories[k] ??= { count: 0, total: 0 };
        categories[k].count++;
        categories[k].total = round(categories[k].total + (Number(r.total) || 0), c);
    }
    return { labor, taxable, expenses, tax, laborTax, expenseTax, total, isWithholding, rate, count: billable.length, categories };
}

export function validNumber(value, max = 1e12) {
    return value !== '' && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= max;
}

export function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function validateReceipt(r, currency) {
    if (!r.vendor || !r.vendor.trim()) throw new Error('Enter a vendor before confirming.');
    if (!validDate(r.date)) throw new Error('Enter a valid receipt date.');
    if (r.time && !/^\d{2}:\d{2}$/.test(r.time)) throw new Error('Enter the time as HH:MM.');
    if (!validNumber(r.total) || Number(r.total) <= 0) throw new Error('Enter a valid total paid amount.');
    if (!r.category?.trim()) throw new Error('Choose a category before confirming.');
    if (r.currency && currency && r.currency !== currency) {
        throw new Error('Receipt currency must match the project currency.');
    }
    return true;
}
