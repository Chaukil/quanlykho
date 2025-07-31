import { db } from './connect.js';
import { doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// Tham chiếu đến tài liệu 'maintenance' trong collection 'settings'
const maintenanceRef = doc(db, 'settings', 'maintenance');

// Thiết lập một trình lắng nghe thời gian thực (real-time listener)
onSnapshot(maintenanceRef, (docSnap) => {
    // Kiểm tra xem tài liệu có tồn tại và trường 'enabled' có giá trị là false không
    if (docSnap.exists() && docSnap.data().enabled === false) {
        // Nếu chế độ bảo trì đã được TẮT, chuyển hướng người dùng về trang đăng nhập
        window.location.href = 'dashboard.html';
    } 
    // Cũng xử lý trường hợp tài liệu bị xóa, coi như bảo trì đã tắt
    else if (!docSnap.exists()) {
        window.location.href = 'dashboard.html';
    }
}, (error) => {
    // Ghi lại lỗi nếu có sự cố với trình lắng nghe
    console.error("Lỗi khi lắng nghe trạng thái bảo trì:", error);
});
