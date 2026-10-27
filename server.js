async function verifyTgCode(password = null) {
    const phone = document.getElementById('tgPhone').value.trim();
    const code = document.getElementById('tgOtp').value.trim();

    if (!code) {
        return Swal.fire('Required', 'Please enter the OTP code you received.', 'warning');
    }

    Swal.fire({
        title: 'Verifying...',
        text: 'Authenticating with Telegram MTProto Servers',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
    });

    try {
        const res = await fetch('/api/tg/verify-code', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ phone, code, phoneCodeHash, password })
        });
        const data = await res.json();
        Swal.close();

        // 2FA Password Check
        if (data.needPassword) {
            const { value: userPass } = await Swal.fire({
                title: 'Two-Step Verification',
                input: 'password',
                inputLabel: 'Enter your Telegram 2FA Cloud Password',
                inputPlaceholder: 'Password',
                showCancelButton: true
            });
            if (userPass) {
                return verifyTgCode(userPass);
            }
            return;
        }

        if (data.success) {
            tgSession = data.session;
            localStorage.setItem('tg_session', tgSession);
            document.getElementById('tgConnectCard').classList.add('hidden');
            document.getElementById('groupsSection').classList.remove('hidden');
            renderGroups(data.groups);
            Swal.fire('Connected!', 'Telegram account linked successfully!', 'success');
        } else {
            Swal.fire('Verification Failed', data.error || 'Invalid code', 'error');
        }
    } catch (e) {
        Swal.fire('Error', e.message, 'error');
    }
}