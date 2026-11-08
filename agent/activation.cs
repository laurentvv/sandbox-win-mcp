using System;
using System.Runtime.InteropServices;

public static class SbxActivation
{
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
        [PreserveSig] int ActivateForFile(IntPtr items, string verb, out uint processId);
        [PreserveSig] int ActivateForProtocol(IntPtr items, out uint processId);
    }

    public static int Launch(string aumid, string arguments)
    {
        object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
        try
        {
            uint pid;
            int hr = ((IApplicationActivationManager)instance).ActivateApplication(aumid, arguments, 0, out pid);
            Marshal.ThrowExceptionForHR(hr);
            if (pid == 0) throw new InvalidOperationException("Activation returned no application process ID.");
            return checked((int)pid);
        }
        finally { Marshal.ReleaseComObject(instance); }
    }
}
