(function applyThemeOnLoad() {
    // Lấy cài đặt từ localStorage (nơi dashboard.js lưu trữ)
    // Chúng ta không biết user là ai, nên chỉ cần tìm key có chứa 'userSettings'
    let savedSettings = null;
    for (let i = 0; i < localStorage.length; i++) {
        if (localStorage.key(i).startsWith('userSettings_')) {
            try {
                savedSettings = JSON.parse(localStorage.getItem(localStorage.key(i)));
                break; // Tìm thấy là dùng luôn
            } catch (e) {
                console.error("Error parsing settings from localStorage", e);
            }
        }
    }

    // Giá trị mặc định nếu không tìm thấy cài đặt
    const theme = savedSettings?.theme || 'light';
    const primaryColor = savedSettings?.primaryColor || '#007bff';
    const primaryRgb = '0, 123, 255'; // Mặc định cho màu xanh

    // Áp dụng lên trang
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.setProperty('--primary-color', primaryColor);
    // Bạn có thể cần thêm logic để chuyển đổi màu hex sang RGB nếu muốn màu chủ đạo thay đổi
    // Tạm thời để mặc định
    document.documentElement.style.setProperty('--primary-rgb', primaryRgb);
})();

// auth.js - EXTREME VERSION
import { auth, db } from './connect.js';
import { 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword,
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

document.addEventListener('DOMContentLoaded', function() {
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const showRegister = document.getElementById('showRegister');
    const showLogin = document.getElementById('showLogin');

    // Toggle forms
    if (showRegister && showLogin) {
        showRegister.addEventListener('click', function(e) {
            e.preventDefault();
            loginForm.style.display = 'none';
            registerForm.style.display = 'block';
        });

        showLogin.addEventListener('click', function(e) {
            e.preventDefault();
            registerForm.style.display = 'none';
            loginForm.style.display = 'block';
        });
    }

    // Handle login
    const loginFormElement = document.getElementById('login-form');
    if (loginFormElement) {
        loginFormElement.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const email = document.getElementById('loginEmail').value;
            const password = document.getElementById('loginPassword').value;

            try {
                const userCredential = await signInWithEmailAndPassword(auth, email, password);
                const user = userCredential.user;
                
                const userDoc = await getDoc(doc(db, 'users', user.uid));
                if (userDoc.exists()) {
                    const userData = userDoc.data();
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
                
                showToast('Đăng nhập thành công!', 'success');
                
                // MANUAL REDIRECT
                setTimeout(() => {
                    window.location.href = 'dashboard.html';
                }, 1500);
                
            } catch (error) {
                showToast(getErrorMessage(error.code), 'danger');
            }
        });
    }

    // Handle register
    const registerFormElement = document.getElementById('register-form');
    if (registerFormElement) {
        registerFormElement.addEventListener('submit', async function(e) {
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
