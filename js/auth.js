(function applyThemeOnLoad() {
    // THAY ĐỔI: Đọc một key chung thay vì lặp qua tất cả cài đặt người dùng
    const savedTheme = localStorage.getItem('app_theme');

    // Nếu có theme đã lưu, áp dụng nó. Nếu không, mặc định là 'light'.
    const theme = savedTheme || 'light';
    const primaryColor = '#007bff'; // Màu mặc định cho trang login
    const primaryRgb = '0, 123, 255';

    // Áp dụng lên trang
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.setProperty('--primary-color', primaryColor);
    document.documentElement.style.setProperty('--primary-rgb', primaryRgb);
})();

// auth.js - EXTREME VERSION
import { auth, db } from './connect.js';
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signOut
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    doc,
    setDoc,
    getDoc,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';


// Show toast notification
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');

    if (toast && toastMessage) {
        toastMessage.textContent = message;
        toast.className = `toast show bg-${type}`;

        const bsToast = new bootstrap.Toast(toast);
        bsToast.show();
    }
}

// KHÔNG CÓ onAuthStateChanged CHO INDEX
// CHỈ CÓ MANUAL LOGIN/REGISTER

document.addEventListener('DOMContentLoaded', function () {
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const forgotPasswordForm = document.getElementById('forgotPasswordForm');
    const formDescription = document.getElementById('form-description');

    const showRegister = document.getElementById('showRegister');
    const showLogin = document.getElementById('showLogin');
    const showForgotPassword = document.getElementById('showForgotPassword');
    const showLoginFromForgot = document.getElementById('showLoginFromForgot');

    function toggleForms(showForm, descText) {
        loginForm.style.display = 'none';
        registerForm.style.display = 'none';
        forgotPasswordForm.style.display = 'none';
        showForm.style.display = 'block';
        formDescription.textContent = descText;
    }

    // Toggle forms
    if (showRegister) {
        showRegister.addEventListener('click', (e) => {
            e.preventDefault();
            toggleForms(registerForm, 'Tạo tài khoản mới để bắt đầu.');
        });
    }
    if (showLogin) {
        showLogin.addEventListener('click', (e) => {
            e.preventDefault();
            toggleForms(loginForm, 'Chào mừng trở lại! Vui lòng đăng nhập.');
        });
    }

    if (showForgotPassword) {
        showForgotPassword.addEventListener('click', (e) => {
            e.preventDefault();
            toggleForms(forgotPasswordForm, 'Đặt lại mật khẩu của bạn.');
        });
    }
    if (showLoginFromForgot) {
        showLoginFromForgot.addEventListener('click', (e) => {
            e.preventDefault();
            toggleForms(loginForm, 'Chào mừng trở lại! Vui lòng đăng nhập.');
        });
    }

    // Handle login
    const loginFormElement = document.getElementById('login-form');

    if (loginFormElement) {
        loginFormElement.addEventListener('submit', async function (e) {
            e.preventDefault();

            const email = document.getElementById('loginEmail').value;
            const password = document.getElementById('loginPassword').value;

            try {
                const userCredential = await signInWithEmailAndPassword(auth, email, password);
                const user = userCredential.user;

                // CHECK MAINTENANCE MODE BEFORE PROCEEDING
                const maintenanceDoc = await getDoc(doc(db, 'settings', 'maintenance'));
                const maintenanceMode = maintenanceDoc.exists() && maintenanceDoc.data().enabled;

                const userDoc = await getDoc(doc(db, 'users', user.uid));
                let userRoleForCheck = 'staff'; // Default role
                if (userDoc.exists()) {
                    const userData = userDoc.data();
                    userRoleForCheck = userData.role;

                    if (userData.status === 'pending') {
                        showToast('Tài khoản của bạn đang chờ phê duyệt từ Admin', 'warning');
                        await signOut(auth);
                        return;
                    } else if (userData.status === 'rejected') {
                        showToast('Tài khoản của bạn đã bị từ chối', 'danger');
                        await signOut(auth);
                        return;
                    }
                }

                if (maintenanceMode && userRoleForCheck !== 'super_admin') {
                    // Chỉ hiển thị thông báo, đăng xuất người dùng và giữ họ ở lại trang đăng nhập.
                    showToast('Hệ thống đang bảo trì. Chỉ Super Admin có thể đăng nhập.', 'warning');
                    await signOut(auth); // <--- ĐÂY LÀ DÒNG LỆNH ĐĂNG XUẤT BẠN
                    return; // Dừng hàm, không chuyển trang
                }

                showToast('Đăng nhập thành công!', 'success');

                // MANUAL REDIRECT
                setTimeout(() => {
                    window.location.href = 'dashboard.html';
                }, 0);

            } catch (error) {
                showToast(getErrorMessage(error.code), 'danger');
            }
        });
    }


    // Handle register
    const registerFormElement = document.getElementById('register-form');
    if (registerFormElement) {
        registerFormElement.addEventListener('submit', async function (e) {
            e.preventDefault();

            const name = document.getElementById('registerName').value;
            const email = document.getElementById('registerEmail').value;
            const password = document.getElementById('registerPassword').value;

            try {
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                const user = userCredential.user;

                await setDoc(doc(db, 'users', user.uid), {
                    name: name,
                    email: email,
                    role: 'staff',
                    status: 'pending',
                    createdAt: serverTimestamp()
                });

                showToast('Đăng ký thành công! Vui lòng chờ Admin phê duyệt tài khoản.', 'success');

                await signOut(auth);

                registerForm.style.display = 'none';
                loginForm.style.display = 'block';

            } catch (error) {
                showToast(getErrorMessage(error.code), 'danger');
            }
        });
    }

    const forgotPasswordFormElement = document.getElementById('forgot-password-form');
    if (forgotPasswordFormElement) {
        forgotPasswordFormElement.addEventListener('submit', async function (e) {
            e.preventDefault();
            const email = document.getElementById('forgotPasswordEmail').value;

            try {
                await sendPasswordResetEmail(auth, email);
                showToast('Gửi email thành công! Vui lòng kiểm tra hộp thư của bạn.', 'success');
                toggleForms(loginForm, 'Chào mừng trở lại! Vui lòng đăng nhập.');
            } catch (error) {
                showToast(getErrorMessage(error.code), 'danger');
            }
        });
    }
});

// Error message mapping
function getErrorMessage(errorCode) {
    const errorMessages = {
        'auth/user-not-found': 'Email không tồn tại',
        'auth/wrong-password': 'Mật khẩu không chính xác',
        'auth/email-already-in-use': 'Email đã được sử dụng',
        'auth/weak-password': 'Mật khẩu quá yếu (tối thiểu 6 ký tự)',
        'auth/invalid-email': 'Email không hợp lệ',
        'auth/too-many-requests': 'Quá nhiều lần thử. Vui lòng thử lại sau.',
        'auth/invalid-credential': 'Thông tin đăng nhập không chính xác'
    };

    return errorMessages[errorCode] || 'Có lỗi xảy ra. Vui lòng thử lại.';
}

export { showToast };
