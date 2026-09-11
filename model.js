export const uid = () => crypto.randomUUID();

export const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const labels = {
    invoiceTitle: 'WRAP SHEET / INVOICE',
    laborTitle: 'Work & equipment',
    expensesTitle: 'Reimbursable expenses',
    totalTitle: 'Total amount due',
    paymentTitle: 'Payment details',
    receiptsTitle: 'Receipt proof'
};

export function newProject() {
    const baseToday = today();

    return {
        id: uid(),
        updatedAt: Date.now(),
        project: {
            projectTitle: '',
            clientName: '',
            clientAddress: '',
            shootStart: baseToday,
            shootEnd: baseToday,
            invoiceDate: baseToday,
            termsPreset: 'due_receipt',
            dueDate: baseToday,
            invoiceNumber: `WS-${baseToday.replaceAll('-', '')}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
            currency: 'KRW',
            notes: 'Thank you for making it happen.',
            taxRate: 3.3
        },
        contractor: {
            name: '',
            email: '',
            phone: '',
            address: '',
            taxId: '',
            bankName: '',
            accountNumber: '',
            paymentTerms: 'Payment due upon receipt.',
            footer: '',
            logo: ''
        },
        labor: [],
        expenses: [],
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

export const precision = currency => currency === 'KRW' ? 0 : 2;

export const round = (n, currency) =>
    Math.round((Number(n) + Number.EPSILON) * 10 ** precision(currency)) / 10 ** precision(currency);

export const money = (n, currency = 'KRW') =>
    new Intl.NumberFormat(currency === 'KRW' ? 'ko-KR' : 'en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: precision(currency)
    }).format(n);

export function totals(s) {
    const c = s.project.currency;
    const line = r => round(r.quantity * r.rate, c);
    const labor = round(s.labor.reduce((n, r) => n + line(r), 0), c);
    const taxable = round(s.labor.filter(r => r.taxable).reduce((n, r) => n + line(r), 0), c);
    const expenses = round(s.expenses.filter(r => r.verified).reduce((n, r) => n + (Number(r.total) || 0), 0), c);
    const tax = round(taxable * s.project.taxRate / 100, c);
    return { labor, taxable, expenses, tax, total: round(labor + expenses + tax, c) };
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
    if (!validNumber(r.total) || Number(r.total) <= 0) throw new Error('Enter a valid total paid amount.');
    if (r.currency && currency && r.currency !== currency) {
        throw new Error('Receipt currency must match the project currency.');
    }
    return true;
}