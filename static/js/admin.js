function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}

document.getElementById('addStudentForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const msgEl = document.getElementById('addMessage');
    const formData = new FormData(form);

    try {
        const resp = await fetch('/admin/students/add', { method: 'POST', body: formData });
        const data = await resp.json();
        if (data.success) {
            showToast(data.message);
            form.reset();
            setTimeout(() => location.reload(), 1000);
        } else {
            msgEl.textContent = data.message;
            msgEl.className = 'form-message error';
        }
    } catch {
        msgEl.textContent = 'Network error. Please try again.';
        msgEl.className = 'form-message error';
    }
});

async function markPresent(studentId, name) {
    try {
        const resp = await fetch(`/admin/students/${studentId}/mark`, { method: 'POST' });
        const data = await resp.json();
        showToast(data.message, data.success ? 'success' : 'error');
        if (data.success) setTimeout(() => location.reload(), 1000);
    } catch {
        showToast('Network error', 'error');
    }
}

async function linkCard(admissionNo) {
    const cardId = prompt('Enter NFC Card ID:');
    if (!cardId) return;

    try {
        const resp = await fetch(`/admin/students/${admissionNo}/link-card`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nfc_card_id: cardId }),
        });
        const data = await resp.json();
        showToast(data.message, data.success ? 'success' : 'error');
        if (data.success) setTimeout(() => location.reload(), 1000);
    } catch {
        showToast('Network error', 'error');
    }
}
